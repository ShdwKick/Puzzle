"use strict";
/**
 * «Что собираем?» — фронт: хэш-роутер (библиотека / стол), вход через SSO
 * необязателен — гость играет во встроенные пазлы без сохранения (см.
 * README.md, «Идея в двух режимах»). Формы деталей — assets/puzzle-shapes.js,
 * геометрия проверена на пиксель-точное совпадение соседних рёбер (см. план).
 */

let auth = null;
let puzzlesCache = new Map(); // ключ — roomId ("" для соло), см. getPuzzles()
let currentRouteAbort = null;

const $ = (root, sel) => root.querySelector(sel);
const CELL = 100;          // размер ячейки сетки в «мировых» пикселях (масштаб — зумом), должно совпадать с CELL в server.js
const PAD_FACTOR = 0.4;    // тот же коэффициент, что зашит в buildPiecePath — держим один здесь и там
const SNAP_TOLERANCE = window.PuzzleClusters.tolerance(CELL); // допуск стыковки — общий модуль с сервером
const MAX_ACTIVE_SESSIONS_PER_ROOM = 5; // только для текста ошибки лимита — сервер решает сам, см. playVariant

// Категории для формы загрузки/публикации (см. план «Модерация загруженных
// фото»). Tier A — абсолютный запрет, действует ВЕЗДЕ, включая приватную
// комнату (см. mountUploadForm). Tier B — только для публикации в общую
// ленту (см. openPublishModal), строже: комната — ответственность круга
// друзей, лента — виден всем без входа. Список — черновик, формулировки
// можно менять как обычный текст, ничего в логике от них не зависит.
const PROHIBITED_TIER_A = [
  "материалы с сексуализацией несовершеннолетних",
  "порнография и откровенно сексуальный контент",
  "интимные фото и видео человека без его согласия",
  "реальное насилие, жестокость, материалы, пропагандирующие терроризм",
  "экстремистская символика, разжигание ненависти по признаку расы, религии, национальности, пола, ориентации",
  "чужие личные документы (паспорт, карты, переписка) без согласия владельца",
];
const PROHIBITED_TIER_B = [
  "любая обнажённость, не только откровенная порнография",
  "жестокость и шокирующий контент, даже нереалистичный",
  "чужой копирайт без разрешения правообладателя",
  "узнаваемые люди без явного согласия на публичный показ",
];

/* ───────────────────────── тема приложения ─────────────────────────
 * Общий переключатель светлой/тёмной темы (data-theme на <html>) — тот же
 * приём, что и во всех остальных сервисах BurningHouse (Movies/Trip/
 * Финансы/Brain). НЕ путать с #boardBgBtn на столе ниже (см. план
 * «RGB-фон стола») — та кнопка красит ТОЛЬКО фон игрового стола
 * произвольным цветом, а не тему всего приложения; обе кнопки остаются,
 * это разные вещи. Кнопка переехала из шапки в модалку «Аккаунт» (см.
 * правку «Тема и обучение — в окно "Аккаунт"», index.html
 * #accountModalThemeBtn, сам клик привязан там же, ниже по файлу) — тут
 * только applyTheme() и текст кнопки, отражающий ЦЕЛЕВУЮ тему (на какую
 * переключит клик), тот же смысл, что раньше был у иконки. */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("puzzle.theme", theme);
  document.getElementById("accountModalThemeBtn").textContent = theme === "dark" ? t("Светлая тема") : t("Тёмная тема");
}

/* ───────────────────────── язык интерфейса ─────────────────────────
 * Только интерфейс (кнопки/подписи/сообщения) — контент (названия пазлов,
 * комнат, категорий без явного nameEn) остаётся как есть, это данные, а
 * не текст интерфейса. SEO-тексты (title/description/H1 на сервере,
 * serveApp) НЕ переключаются — сайт русскоязычный, под англоязычную
 * аудиторию в будущем планируется отдельный домен, не /en/-путь. Выбор —
 * localStorage, чисто клиентская настройка, тот же приём, что у темы
 * (applyTheme выше) и фона стола (bindBoardBackground). EN — словарь
 * "русский текст" → "английский текст", а не абстрактные ключи: t(ru)
 * оборачивает уже существующую русскую строку без переименования, и
 * отсутствующий перевод просто молча показывает русский оригинал, а не
 * падает. Новые пары добавляются перед строкой EN_END ниже. */
const LANG_KEY = "puzzle_lang";
function getLang() {
  return localStorage.getItem(LANG_KEY) === "en" ? "en" : "ru";
}
/** t(ru) — вернуть перевод строки ru на текущий язык интерфейса, либо
 *  саму ru, если язык русский или перевода в словаре нет. */
function t(ru) {
  return getLang() === "en" ? (EN[ru] || ru) : ru;
}
/** tn(n, [ru1,ru2,ru3], [en1,en2]) — число + склонение на текущем языке:
 *  по-русски — три формы через plural() (определена ниже в файле, но
 *  вызывается только во время реального рендера, не при разборе этого
 *  файла, так что порядок объявления не важен), по-английски — обычные
 *  единственное/множественное. */
function tn(n, ru, en) {
  return getLang() === "en" ? (n === 1 ? en[0] : en[1]) : plural(n, ru[0], ru[1], ru[2]);
}
// Первый вызов applyTheme() — тут, а не сразу после её объявления выше:
// applyTheme читает t()/getLang()/LANG_KEY (см. выше), а те объявлены
// именно тут, чуть ниже по файлу — const в TDZ, вызов до этой строки падал
// с "Cannot access 'LANG_KEY' before initialization" при самой первой
// загрузке страницы (регресс, найден при живой проверке страницы пазла).
applyTheme(localStorage.getItem("puzzle.theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
/** Английское название категории, если задано И выбран английский
 *  интерфейс — иначе всегда name (см. план «Английский язык в
 *  интерфейсе», nameEn — необязательное поле, ставит только Admin). */
function categoryDisplayName(c) {
  return getLang() === "en" && c.nameEn ? c.nameEn : c.name;
}
/** «Стр. X из Y» — общий текст пагинатора (см. .pager/PAGER_HTML), везде
 *  один и тот же формат — библиотека, категории, комнаты, «Продолжить
 *  сборку» — поэтому один общий хелпер, а не отдельный t() на каждом
 *  месте использования. */
function pagerLabel(current, total) {
  return getLang() === "en" ? `Page ${current} of ${total}` : `Стр. ${current} из ${total}`;
}
const EN = {
  "Тема": "Theme",
  "Категории": "Categories",
  "Комнаты": "Rooms",
  "Войти": "Log in",
  "Установить как приложение": "Install app",
  "Аккаунт": "Account",
  "аккаунт": "account",
  "Управление аккаунтом →": "Manage account →",
  "Выйти": "Log out",
  "Создать комнату": "Create room",
  "Название комнаты": "Room name",
  "Создать": "Create",
  "Присоединиться к комнате": "Join a room",
  "Код комнаты": "Room code",
  "Найти": "Find",
  "Добавить пазл": "Add puzzle",
  "Выберите сложность": "Choose difficulty",
  "Играть": "Play",
  "Опубликовать в общую библиотеку": "Publish to the library",
  "Отправить на модерацию": "Submit for review",
  "Предложить новую категорию (пойдёт на модерацию) — необязательно": "Suggest a new category (goes to review) — optional",
  "Закрыть": "Close",
  "Пазлы онлайн бесплатно — часть семьи сервисов BurningHouse.": "Free online jigsaw puzzles — part of the BurningHouse family of services.",
  "Сервис": "Service",
  "Библиотека пазлов": "Puzzle library",
  "Показать ещё категории": "Show more categories",
  "Свернуть категории": "Show fewer categories",
  "Семья BurningHouse": "BurningHouse family",
  "Все сервисы": "All services",
  "© BurningHouse": "© BurningHouse",
  "Частые вопросы о сборке пазлов онлайн": "Frequently asked questions about online jigsaw puzzles",
  "Нужна ли регистрация, чтобы собирать пазлы онлайн?": "Do I need to register to solve puzzles online?",
  "Нет — играть можно сразу и бесплатно, без регистрации. Прогресс в этом случае хранится в браузере; вход нужен только для того, чтобы он не терялся при смене устройства.": "No — you can start playing right away, for free, without registering. Progress is then stored in your browser; logging in is only needed so it isn't lost when you switch devices.",
  "Можно ли собрать пазл из своей фотографии?": "Can I make a puzzle from my own photo?",
  "Да — в комнате можно загрузить любую фотографию, и сервис сам нарежет её на фигурные детали нужной сложности.": "Yes — in a room you can upload any photo, and the service will cut it into jigsaw pieces at the difficulty you choose.",
  "Можно ли собирать пазл вместе с друзьями онлайн?": "Can I solve a puzzle together with friends online?",
  "Да — создайте комнату и поделитесь ссылкой: все участники видят один стол и собирают пазл вместе в реальном времени.": "Yes — create a room and share the link: everyone sees the same table and solves the puzzle together in real time.",
  "Сколько это стоит?": "How much does it cost?",
  "Ничего — сервис полностью бесплатный.": "Nothing — the service is completely free.",
  "На каких устройствах это работает?": "What devices does it work on?",
  "В любом браузере — на компьютере, планшете или телефоне, ничего скачивать не нужно.": "In any browser — on a computer, tablet or phone, nothing to download.",
  "Выберите файл": "Choose a file",
  "Загрузка категорий…": "Loading categories…",
  "Мой пазл": "My puzzle",
  "Название — необязательно": "Title — optional",
  "Не удалось загрузить — попробуйте ещё раз.": "Upload failed — please try again.",
  "Не удалось отправить на модерацию — попробуйте ещё раз.": "Couldn't submit for review — please try again.",
  "Нельзя загружать фото, которые относятся к следующим категориям:": "You can't upload photos that fall into the following categories:",
  "Нужно подтвердить согласие с правилами публикации.": "You need to agree to the publishing rules.",
  "Опубликовать": "Publish",
  "Собрать из фото": "Build from photo",
  "Уровень": "Level",
  "Файл не похож на изображение (JPEG/PNG/WebP).": "This doesn't look like an image (JPEG/PNG/WebP).",
  "Файл слишком большой даже после сжатия.": "The file is too large even after compression.",
  "Я подтверждаю, что несу ответственность за загруженное фото и что оно не относится к перечисленным категориям": "I confirm I'm responsible for the uploaded photo and that it doesn't fall into the listed categories",
  "Легко": "Easy",
  "Легко+": "Easy+",
  "Средне": "Medium",
  "Средне+": "Medium+",
  "Сложно": "Hard",
  "Сложно+": "Hard+",
  "Эксперт": "Expert",
  "Эксперт+": "Expert+",
  "Мастер": "Master",
  "Мастер+": "Master+",
  "Легенда": "Legend",
  "материалы с сексуализацией несовершеннолетних": "material sexualizing minors",
  "порнография и откровенно сексуальный контент": "pornography and explicit sexual content",
  "интимные фото и видео человека без его согласия": "intimate photos or videos of a person without their consent",
  "реальное насилие, жестокость, материалы, пропагандирующие терроризм": "real violence, cruelty, material promoting terrorism",
  "экстремистская символика, разжигание ненависти по признаку расы, религии, национальности, пола, ориентации": "extremist symbols, hate speech based on race, religion, nationality, gender, or orientation",
  "чужие личные документы (паспорт, карты, переписка) без согласия владельца": "someone else's personal documents (passport, cards, correspondence) without the owner's consent",
  "любая обнажённость, не только откровенная порнография": "any nudity, not just explicit pornography",
  "жестокость и шокирующий контент, даже нереалистичный": "cruelty and shocking content, even unrealistic",
  "чужой копирайт без разрешения правообладателя": "someone else's copyrighted work without the rights holder's permission",
  "узнаваемые люди без явного согласия на публичный показ": "recognizable people without explicit consent to be shown publicly",
  "Назад": "Back",
  "Вперёд": "Next",
  "Продолжить сборку": "Continue building",
  "За стол": "Play",
  "Удалить прогресс": "Delete progress",
  "Пазлы онлайн бесплатно — собрать пазл в браузере": "Free online jigsaw puzzles — solve them right in your browser",
  "Собирайте пазлы онлайн бесплатно и без скачивания — готовые из библиотеки или свои из любой фотографии. Детали фигурные, стол зумится и двигается, можно собирать одному или вместе с друзьями в комнате. Вход нужен только для того, чтобы прогресс сохранялся между заходами.":
    "Solve jigsaw puzzles online for free, no downloads — ready-made from the library or your own from any photo. Pieces are shaped, the table zooms and pans, and you can solve alone or with friends in a room. Logging in is only needed to keep your progress between visits.",
  "Загружаем…": "Loading…",
  "Играть можно без входа — прогресс тогда хранится только в этом браузере.": "You can play without logging in — progress is then stored only in this browser.",
  "Войти и сохранять прогресс": "Log in and save progress",
  "Не удалось загрузить пазлы — обновите страницу.": "Couldn't load puzzles — please refresh the page.",
  "Все": "All",
  "Не нашли нужные пазлы?": "Didn't find the puzzles you wanted?",
  "Предложите категорию, которой не хватает — рассмотрим и добавим.": "Suggest a category that's missing — we'll take a look and add it.",
  "Войти, чтобы предложить категорию": "Log in to suggest a category",
  "Например: Космос": "e.g. Space",
  "Предложить": "Suggest",
  "Спасибо! Категория отправлена на рассмотрение.": "Thanks! The category has been sent for review.",
  "Не удалось отправить — попробуйте ещё раз.": "Couldn't submit — please try again.",
  "Пазлы, опубликованные": "Puzzles published by",
  "Профиль": "Profile",
  "Пользователь ничего не опубликовал.": "This user hasn't published anything.",
  "Не удалось загрузить профиль — обновите страницу.": "Couldn't load the profile — please refresh the page.",
  "Пока ничего не опубликовано.": "Nothing published yet.",
  "Категории пазлов онлайн": "Online puzzle categories",
  "Выберите категорию — соберите пазл по теме, бесплатно и без регистрации.": "Choose a category — solve a puzzle on that theme, free and without registration.",
  "Не удалось загрузить категории — обновите страницу.": "Couldn't load categories — please refresh the page.",
  "Категорий пока нет.": "No categories yet.",
  "Категория не найдена": "Category not found",
  "Такой категории нет — возможно, её переименовали или удалили. ": "This category doesn't exist — it may have been renamed or removed. ",
  "Все категории": "All categories",
  "Пазлы:": "Puzzles:",
  "В этой категории пока нет пазлов. ": "There are no puzzles in this category yet. ",
  "Не удалось загрузить категорию — обновите страницу.": "Couldn't load the category — please refresh the page.",
  "Добавил:": "Added by:",
  "На модерации": "Under review",
  "Опубликовано": "Published",
  "Отклонено:": "Rejected:",
  "без причины": "no reason given",
  "Удалить": "Delete",
  "Удалить пазл": "Delete puzzle",
  "Этим пазлом уже играли в комнате — удалить нельзя.": "This puzzle has already been played in a room — it can't be deleted.",
  "Не удалось удалить.": "Couldn't delete.",
  "Убрать из этой комнаты": "Remove from this room",
  "Убрать пазл": "Remove puzzle",
  "из этой комнаты? Он останется доступен во всех остальных комнатах и в общей библиотеке — можно будет добавить снова.": "from this room? It will stay available in all other rooms and in the shared library — you can add it again later.",
  "Не удалось убрать.": "Couldn't remove.",
  "Отправить снова": "Resubmit",
  "+ В комнату": "+ Add to room",
  "Загрузка…": "Loading…",
  "Не удалось загрузить комнаты.": "Couldn't load rooms.",
  "У вас пока нет комнат.": "You don't have any rooms yet.",
  "Перейти к комнатам": "Go to rooms",
  "Не удалось начать сборку.": "Couldn't start the build.",
  "Готово": "Done",
  "Изменить размер": "Resize",
  "Библиотека": "Library",
  "Хлебные крошки": "Breadcrumbs",
  "Сложность": "Difficulty",
  "Перемешать": "Shuffle",
  "Показать картинку": "Show picture",
  "Фон стола — выбрать цвет": "Table background — pick a color",
  "Вернуть фон по умолчанию": "Reset to default background",
  "Режим выделения": "Selection mode",
  "Приблизить": "Zoom in",
  "Показать всё": "Fit to view",
  "Отдалить": "Zoom out",
  "Не удалось загрузить пазл — обновите страницу.": "Couldn't load the puzzle — please refresh the page.",
  "Такого пазла нет.": "This puzzle doesn't exist.",
  "Пазлы из своих фото собираются только в комнатах.": "Puzzles from your own photos can only be solved in rooms.",
  "К комнатам": "To rooms",
  "Готово!": "Done!",
  "меньше минуты": "under a minute",
  "Время сборки": "Assembly time",
  "Деталей": "Pieces",
  "Остаться": "Stay",
  "На главную": "To home",
  "В комнату": "To room",
  "Действия": "Actions",
  "Комната": "Room",
  "Соберите пазл вместе с друзьями — детали двигаются в реальном времени для всех, кто за столом.": "Solve a puzzle together with friends — pieces move in real time for everyone at the table.",
  "Пока нет ни одной комнаты — создайте первую.": "No rooms yet — create the first one.",
  "Не удалось загрузить комнаты — обновите страницу.": "Couldn't load rooms — please refresh the page.",
  "Войдите, чтобы комната была видна и с других устройств.": "Sign in so the room is visible on other devices too.",
  "Вы не участник этой комнаты.": "You're not a member of this room.",
  "Не удалось загрузить комнату — обновите страницу.": "Couldn't load the room — please refresh the page.",
  "Скопировать код": "Copy code",
  "Скопировать ссылку": "Copy link",
  "Скопировано": "Copied",
  "История сборок": "Build history",
  "Не удалось убрать участника.": "Couldn't remove the member.",
  "Удалить комнату": "Delete room",
  "Не удалось удалить комнату.": "Couldn't delete the room.",
  "Начать сборку": "Start a build",
  "Загружаем пазлы…": "Loading puzzles…",
  "За этим столом сейчас кто-то сидит — сначала все должны выйти.": "Someone is currently at this table — everyone needs to leave first.",
  "Не удалось загрузить пазлы.": "Couldn't load puzzles.",
  "Войдите, чтобы добавить своё фото.": "Sign in to add your own photo.",
  "Ещё ничего не собрано.": "Nothing solved yet.",
  "Собрать ещё раз": "Solve again",
  "Продолжить": "Continue",
  "Вы уже собирали этот пазл": "You've already solved this puzzle",
  "Вы уже начали этот пазл": "You've already started this puzzle",
  "Секунду…": "One second…",
  "Приглашение не найдено или больше не действует.": "This invite wasn't found or is no longer valid.",
  "Не удалось открыть стол — обновите страницу.": "Couldn't open the table — please refresh the page.",
  "Участники за столом": "People at the table",
  "За столом": "At the table",
  "Этот пазл уже собран.": "This puzzle is already solved.",
  "Вернуться в комнату": "Back to room",
  "Что-то пошло не так — обновите страницу.": "Something went wrong — please refresh the page.",
  "Не удалось запуститься — обновите страницу.": "Couldn't start — please refresh the page.",
  "участник": "member",
  "Из библиотеки": "From the library",
  "Загрузить своё фото": "Upload your own photo",
  "В этой комнате пока нет пазлов": "No puzzles in this room yet",
  "Добавьте первый — из общей библиотеки или загрузите своё фото.": "Add the first one — from the shared library, or upload your own photo.",
  "Категория": "Category",
  "Пусто.": "Nothing here.",
  "Не удалось загрузить библиотеку.": "Couldn't load the library.",
  "В библиотеке пока нет ни одного пазла.": "The library doesn't have any puzzles yet.",
  "Уже добавлен": "Already added",
  "Добавить": "Add",
  "Не удалось добавить.": "Couldn't add.",
  "Без категории (по умолчанию — «Пользовательские»)": "No category (default — “User-submitted”)",
  "Чат": "Chat",
  "Пока никто ничего не написал.": "No one's written anything yet.",
  "Сообщение…": "Message…",
  "Отправить": "Send",
  "Скопировать ссылку на пазл": "Copy puzzle link",
  "Оцените пазл:": "Rate this puzzle:",
  "Оценка": "Rating",
  "Спасибо за оценку!": "Thanks for rating!",
  "Обучение": "Help",
  "Пропустить": "Skip",
  "Дальше": "Next",
  "Стол сборки": "The build table",
  "Тащите детали и стыкуйте — совпавшие сами защёлкнутся в кластер. Покажем, где что на столе — можно пропустить в любой момент.":
    "Drag pieces and connect them — matching ones snap into a cluster on their own. We'll show you where everything is — skip anytime.",
  "Возвращает назад — прогресс сборки сохраняется, продолжить можно в любой момент.":
    "Takes you back — build progress is saved, you can continue anytime.",
  "Раскидывает ещё не собранные детали по столу заново — пригодится, если они слиплись в кучу.":
    "Scatters the not-yet-placed pieces across the table again — handy if they've piled up.",
  "Показывает исходное фото пазла для ориентира.": "Shows the puzzle's original photo for reference.",
  "Свой цвет фона — если деталь плохо видна на исходном фоне, замените его.":
    "Pick your own table color — if a piece is hard to see against the default, change it.",
  "Рамкой выделяет сразу несколько деталей — на телефоне и планшете это замена зажатому Shift на компьютере.":
    "Marquee-selects several pieces at once — on phone/tablet this replaces holding Shift on a computer.",
  "Приближает, отдаляет и одной кнопкой показывает весь стол целиком.":
    "Zooms in, zooms out, and fits the whole table into view with one button.",
  "Общий чат за этим столом — сообщения не сохраняются, видны только пока открыта комната.":
    "Shared chat at this table — messages aren't saved, only visible while the room is open.",
  "Кто сейчас собирает этот пазл вместе с вами.": "Who's currently building this puzzle with you.",
  "Готовые пазлы для сборки — выберите любой и приступайте, вход не нужен. Покажем, где что — можно пропустить в любой момент.":
    "Ready-made puzzles to build — pick any one and dive in, no login needed. We'll show you where everything is — skip anytime.",
  "Пазлы, сгруппированные по темам — можно смотреть по одной вместо всей библиотеки сразу.":
    "Puzzles grouped by theme — browse one at a time instead of the whole library at once.",
  "Карточка пазла": "Puzzle card",
  "Нажмите на неё — откроется превью с рейтингом и автором (если это чьё-то фото). Кнопка «За стол» рядом сразу открывает выбор сложности.":
    "Click it — a preview opens with the rating and the author (if it's someone's own photo). The “Play” button next to it opens the difficulty picker right away.",
  "Собирайте пазл вместе с друзьями в реальном времени — общий стол, чат и список участников.":
    "Build a puzzle together with friends in real time — a shared table, chat, and a list of who's there.",
  "Вход": "Log in",
  "Сохраняет прогресс между заходами. Без входа тоже можно играть — прогресс останется в этом браузере.":
    "Saves your progress between visits. You can play without logging in too — progress just stays in this browser.",
  "Это обучение": "This tutorial",
  "Открыть заново можно этой же кнопкой в любой момент.": "Reopen it anytime with this same button.",
  "Подсказка": "Hint",
  "Свернуть/развернуть инструменты": "Collapse/expand tools",
  "Звук — выключить": "Sound — turn off",
  "Звук — включить": "Sound — turn on",
  "Уведомления": "Notifications",
  "Нет уведомлений": "No notifications",
  "Не удалось загрузить уведомления.": "Couldn't load notifications.",
  "Светлая тема": "Light theme",
  "Тёмная тема": "Dark theme",
  "Вход нужен только для того, чтобы прогресс сохранялся между заходами.":
    "You only need to log in so your progress is saved between visits.",
  // EN_END — новые пары словаря добавляются строго перед этой строкой.
};
function applyLangButton() {
  const btn = document.getElementById("langBtn");
  btn.textContent = getLang() === "en" ? "RU" : "EN";
  btn.title = getLang() === "en" ? "Switch to Russian" : "Переключить на английский";
  btn.setAttribute("aria-label", btn.title);
}
// Дословно те же вопрос/ответ, что в футере index.html (faqQ0..4/faqA0..4)
// — id-шники там расставлены именно под этот массив, менять один без
// другого нельзя.
const FAQ_ITEMS = [
  { q: "Нужна ли регистрация, чтобы собирать пазлы онлайн?", a: "Нет — играть можно сразу и бесплатно, без регистрации. Прогресс в этом случае хранится в браузере; вход нужен только для того, чтобы он не терялся при смене устройства." },
  { q: "Можно ли собрать пазл из своей фотографии?", a: "Да — в комнате можно загрузить любую фотографию, и сервис сам нарежет её на фигурные детали нужной сложности." },
  { q: "Можно ли собирать пазл вместе с друзьями онлайн?", a: "Да — создайте комнату и поделитесь ссылкой: все участники видят один стол и собирают пазл вместе в реальном времени." },
  { q: "Сколько это стоит?", a: "Ничего — сервис полностью бесплатный." },
  { q: "На каких устройствах это работает?", a: "В любом браузере — на компьютере, планшете или телефоне, ничего скачивать не нужно." },
];
/** Переводит статичную разметку index.html — шапку/футер/модалки — то,
 *  что живёт вне #app и не перерисовывается роутером (см. план «Английский
 *  язык в интерфейсе»). Вызывается один раз при загрузке (подхватить
 *  сохранённый выбор) и при каждом переключении языка (setLang ниже);
 *  JS-рендер внутри #app сам подхватывает t()/tn() при следующем route(). */
function applyStaticTranslations() {
  const byId = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
  byId("installBtn", el => { el.title = t("Установить как приложение"); el.setAttribute("aria-label", el.title); });
  document.querySelectorAll('a.icon-btn[href="/categories"]').forEach(el => { el.title = t("Категории"); el.setAttribute("aria-label", el.title); });
  document.querySelectorAll('a.icon-btn[href="/rooms"]').forEach(el => { el.title = t("Комнаты"); el.setAttribute("aria-label", el.title); });

  // Модалки — статичный текст (заголовки/кнопки/подписи), сам контент
  // (списки категорий, имя аккаунта и т.п.) остаётся динамическим и
  // переводится там, где рендерится (openPublishModal и т.п. — см. ниже).
  byId("accountModalTitle", el => { el.textContent = t("Аккаунт"); });
  byId("accountModalGuestNote", el => { el.textContent = t("Вход нужен только для того, чтобы прогресс сохранялся между заходами."); });
  byId("accountModalLoginBtn", el => { el.textContent = t("Войти"); });
  byId("accountModalManage", el => { el.textContent = t("Управление аккаунтом →"); });
  byId("accountNotificationsHeading", el => { el.textContent = t("Уведомления"); });
  byId("accountModalLogout", el => { el.textContent = t("Выйти"); });
  byId("accountModalTourBtn", el => { el.textContent = t("Обучение"); });
  byId("createRoomModalTitle", el => { el.textContent = t("Создать комнату"); });
  byId("newRoomTitle", el => { el.placeholder = t("Название комнаты"); });
  byId("createRoomBtn", el => { el.textContent = t("Создать"); });
  byId("joinRoomModalTitle", el => { el.textContent = t("Присоединиться к комнате"); });
  byId("joinCodeInput", el => { el.placeholder = t("Код комнаты"); });
  byId("joinCodeBtn", el => { el.title = t("Найти"); el.setAttribute("aria-label", el.title); });
  byId("uploadPuzzleModalTitle", el => { el.textContent = t("Добавить пазл"); });
  byId("addPuzzleTabLibrary", el => { el.textContent = t("Из библиотеки"); });
  byId("addPuzzleTabUpload", el => { el.textContent = t("Загрузить своё фото"); });
  byId("difficultyModalTitle", el => { el.textContent = t("Выберите сложность"); });
  byId("difficultyPlayBtn", el => { el.textContent = t("Играть"); });
  byId("puzzlePreviewPlayBtn", el => { el.textContent = t("За стол"); });
  byId("puzzlePreviewShareBtn", el => { el.title = t("Скопировать ссылку на пазл"); el.setAttribute("aria-label", el.title); });
  byId("publishModalTitle", el => { el.textContent = t("Опубликовать в общую библиотеку"); });
  byId("publishConfirmBtn", el => { el.textContent = t("Отправить на модерацию"); });
  byId("publishNewCategoryName", el => { el.placeholder = t("Предложить новую категорию (пойдёт на модерацию) — необязательно"); });
  document.querySelectorAll('.modal-backdrop .icon-btn[aria-label="Закрыть"]').forEach(el => { el.setAttribute("aria-label", t("Закрыть")); });

  // Футер — вне #app, живёт постоянно (см. план «Футер»).
  byId("footerTagline", el => { el.textContent = t("Пазлы онлайн бесплатно — часть семьи сервисов BurningHouse."); });
  byId("footerServiceHeading", el => { el.textContent = t("Сервис"); });
  byId("footerFamilyHeading", el => { el.textContent = t("Семья BurningHouse"); });
  byId("footerLinkLibrary", el => { el.textContent = t("Библиотека пазлов"); });
  byId("footerLinkCategories", el => { el.textContent = t("Категории"); });
  byId("footerLinkRooms", el => { el.textContent = t("Комнаты"); });
  byId("footerLinkAllServices", el => { el.textContent = t("Все сервисы"); });
  byId("footerCopy", el => { el.textContent = t("© BurningHouse"); });
  byId("faqHeading", el => { el.textContent = t("Частые вопросы о сборке пазлов онлайн"); });
  FAQ_ITEMS.forEach((item, i) => {
    byId(`faqQ${i}`, el => { el.textContent = t(item.q); });
    byId(`faqA${i}`, el => { el.textContent = t(item.a); });
  });
}
function setLang(lang) {
  localStorage.setItem(LANG_KEY, lang);
  document.documentElement.lang = lang;
  applyLangButton();
  applyStaticTranslations();
  // accountBtn.title/theme-кнопка текстом зависят от языка, но выставляются
  // не тут (renderAuthArea/applyTheme, а не applyStaticTranslations) — иначе
  // при переключении языка застряли бы в прежнем, до следующей смены
  // auth-состояния/темы.
  renderAuthArea();
  applyTheme(document.documentElement.dataset.theme);
  route();
}
document.getElementById("langBtn").onclick = () => setLang(getLang() === "en" ? "ru" : "en");
applyLangButton();
document.documentElement.lang = getLang();
applyStaticTranslations();

/* ───────────────────────── установка как PWA ─────────────────────────
 * Chrome/Edge не показывают системный баннер установки сами — вместо этого
 * шлют beforeinstallprompt и ждут явного вызова .prompt() из интерфейса.
 * Событие приходит только если manifest.json уже валиден (иконки/start_url/
 * display) — до этого кнопка просто остаётся скрытой, никакой отдельной
 * фиче-детекции не нужно. Уже запущенное как приложение окно (display-mode:
 * standalone) событие не получает вовсе — на всякий случай прячем кнопку
 * и в этом случае тоже явно. */
let deferredInstallPrompt = null;
const installBtn = document.getElementById("installBtn");
if (!matchMedia("(display-mode: standalone)").matches) {
  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBtn.hidden = false;
  });
}
installBtn.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  installBtn.hidden = true;
  const prompt = deferredInstallPrompt;
  deferredInstallPrompt = null;
  prompt.prompt();
  await prompt.userChoice; // outcome нас не интересует — кнопку в любом случае прячем
});
window.addEventListener("appinstalled", () => { installBtn.hidden = true; deferredInstallPrompt = null; });

/* ───────────────────────── модалки: общий каркас ─────────────────────────
 * Дословно как в Movies (не завязано на специфику сервиса) — подложка на
 * весь экран + карточка по центру, закрытие по крестику/клику по подложке. */
let openModalId = null; // id открытого .modal-backdrop
function openModal(backdropId) {
  document.getElementById(backdropId).classList.remove("hidden");
  document.body.classList.add("modal-open");
  openModalId = backdropId;
}
function closeModal(backdropId) {
  const b = document.getElementById(backdropId);
  if (!b || b.classList.contains("hidden")) return;
  b.classList.add("hidden");
  document.body.classList.remove("modal-open");
  if (openModalId === backdropId) openModalId = null;
}
function bindModal(backdropId, openBtnId, closeBtnId) {
  if (openBtnId) document.getElementById(openBtnId).onclick = () => openModal(backdropId);
  if (closeBtnId) document.getElementById(closeBtnId).onclick = () => closeModal(backdropId);
  document.getElementById(backdropId).addEventListener("click", e => {
    if (e.target === document.getElementById(backdropId)) closeModal(backdropId);
  });
}

/* ───────────────────────── модалка выбора сложности ─────────────────────────
 * Общая на все карточки пазлов (библиотека и комната), не привязана к
 * конкретному рендеру — buildCard() ниже всегда показывает одну кнопку
 * «За стол»; если у пазла больше одного уровня сложности, клик открывает
 * эту модалку с выпадающим списком, выбор происходит ПОСЛЕ клика на «За
 * стол», а не вместо него (раньше — ряд мелких кнопок прямо на карточке). */
/** Заполняет <select> уровнями сложности — общая часть модалки выбора
 *  сложности и превью пазла (см. openPuzzlePreviewModal ниже), чтобы не
 *  дублировать формулу подписи («Уровень N — M деталей»). */
function buildDifficultyOptions(select, variants) {
  select.innerHTML = "";
  variants.forEach((v, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    // Число деталей — рядом с названием уровня (см. правку): без него все
    // уровни выглядят одинаково информативными, хотя разница между ними —
    // именно в количестве деталей.
    const total = v.gridRows * v.gridCols;
    opt.textContent = `${t(DIFFICULTY_LABELS[i]) || `${t("Уровень")} ${i + 1}`} — ${total} ${tn(total, ["деталь", "детали", "деталей"], ["piece", "pieces"])}`;
    select.appendChild(opt);
  });
}
let pendingDifficultyChoice = null; // {variants, onPlay, idx} между открытием модалки и подтверждением выбора
/** Плитки уровней сложности вместо прежнего <select> (см. план
 *  «Стилистически интереснее») — та же подпись «Уровень — N деталей», что
 *  строила buildDifficultyOptions, просто карточкой, не строкой списка.
 *  Перерисовывается целиком при каждом выборе — вариантов всего 6, дороже
 *  городить точечное обновление одного класса, чем один невидимый reflow. */
function renderDifficultyGrid(grid, variants, choice) {
  grid.innerHTML = "";
  variants.forEach((v, i) => {
    const total = v.gridRows * v.gridCols;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "difficulty-pill" + (i === choice.idx ? " is-selected" : "");
    btn.setAttribute("aria-pressed", String(i === choice.idx));
    const level = document.createElement("span");
    level.className = "difficulty-pill-level";
    level.textContent = t(DIFFICULTY_LABELS[i]) || `${t("Уровень")} ${i + 1}`;
    const count = document.createElement("span");
    count.className = "difficulty-pill-count";
    count.textContent = `${total} ${tn(total, ["деталь", "детали", "деталей"], ["piece", "pieces"])}`;
    btn.append(level, count);
    btn.addEventListener("click", () => { choice.idx = i; renderDifficultyGrid(grid, variants, choice); });
    grid.appendChild(btn);
  });
}
function openDifficultyModal(title, variants, onPlay) {
  // h2 — sr-only (см. styles.css, тот же приём, что у превью пазла), видимое
  // название — в .difficulty-caption под картинкой.
  document.getElementById("difficultyModalTitle").textContent = `${t("Выберите сложность")} — «${title}»`;
  document.getElementById("difficultyCaption").textContent = title;
  const img = document.getElementById("difficultyImage");
  img.src = variants[0].imageUrl; img.alt = title;
  pendingDifficultyChoice = { variants, onPlay, idx: 0 };
  renderDifficultyGrid(document.getElementById("difficultyGrid"), variants, pendingDifficultyChoice);
  document.getElementById("difficultyAsymmetric").checked = false; // не запоминаем между открытиями — осознанный выбор каждый раз
  document.getElementById("difficultyRotate").checked = false;
  openModal("difficultyModalBackdrop");
}
bindModal("difficultyModalBackdrop", null, "difficultyModalClose");
document.getElementById("difficultyPlayBtn").addEventListener("click", () => {
  if (!pendingDifficultyChoice) return;
  const { variants, onPlay, idx } = pendingDifficultyChoice;
  const asymmetric = document.getElementById("difficultyAsymmetric").checked;
  const rotate = document.getElementById("difficultyRotate").checked;
  closeModal("difficultyModalBackdrop");
  pendingDifficultyChoice = null;
  onPlay(variants[idx], asymmetric, rotate);
});

/* ───────────────────────── превью пазла ─────────────────────────
 * Открывается кликом по самой карточке (см. buildCard ниже) — не по кнопке
 * «За стол», та по-прежнему сразу зовёт openDifficultyModal выше (быстрый
 * путь остаётся). Тут — картинка покрупнее, автор (если чья-то публикация),
 * рейтинг и тот же выбор сложности + «За стол» ещё раз, плюс «Поделиться»
 * (см. план «Поделиться из превью и окна победы»). Статичная модалка —
 * переиспользуется между открытиями (см. bindShareButton выше — там же
 * объяснение, почему .onclick=, а не addEventListener). */
async function openPuzzlePreviewModal(p, { variants, onPlay }) {
  const displayTitle = puzzleDisplayTitle(p);
  // h2 — sr-only (только aria-labelledby, см. styles.css), видимое название
  // теперь в .puzzle-preview-caption рядом с рейтингом (тот же приём, что
  // .movie-info-caption в Movies) — оба выставляем одним и тем же текстом.
  document.getElementById("puzzlePreviewTitle").textContent = displayTitle;
  document.getElementById("puzzlePreviewCaptionTitle").textContent = displayTitle;
  const img = document.getElementById("puzzlePreviewImage");
  img.src = p.imageUrl;
  img.alt = displayTitle;

  // Автор — то же условие, что у buildCard (см. .puzzle-card-author там):
  // только у ОДОБРЕННЫХ публикаций, встроенные/добавленные через Admin —
  // без uploaderUsername вовсе, туда эта ветка не попадает.
  const authorEl = document.getElementById("puzzlePreviewAuthor");
  if (p.uploaderUsername && p.moderationStatus === "approved") {
    authorEl.hidden = false;
    authorEl.href = `/profile/${encodeURIComponent(p.uploaderUserId)}`;
    authorEl.textContent = `${t("Добавил:")} ${p.uploaderUsername}`;
  } else {
    authorEl.hidden = true;
  }

  const select = document.getElementById("puzzlePreviewDifficulty");
  buildDifficultyOptions(select, variants);
  document.getElementById("puzzlePreviewAsymmetric").checked = false;
  document.getElementById("puzzlePreviewRotate").checked = false;

  // Поделиться — только у ПУБЛИЧНОГО пазла (ownerUserId===null): своё
  // ещё не опубликованное фото по /puzzle/:id отдаст 404 не-автору (см.
  // server.js, api() GET /api/puzzles/:id), ссылка была бы бесполезной.
  // /puzzle/:id, не /table/:id (см. план «Страница пазла вместо
  // превью-модалки») — ссылка читает ТЕКУЩИЙ выбор сложности в момент клика
  // (getUrl — колбэк, не готовая строка), меняется вместе со select без
  // пересборки обработчика.
  const shareBtn = document.getElementById("puzzlePreviewShareBtn");
  shareBtn.hidden = !!p.ownerUserId;
  if (!p.ownerUserId) {
    bindShareButton(shareBtn, () => {
      const variant = variants[Number(select.value)] || variants[0];
      return `${location.origin}/puzzle/${encodeURIComponent(variant.id)}`;
    });
  }

  document.getElementById("puzzlePreviewPlayBtn").onclick = () => {
    const idx = Number(select.value);
    const asymmetric = document.getElementById("puzzlePreviewAsymmetric").checked;
    const rotate = document.getElementById("puzzlePreviewRotate").checked;
    closeModal("puzzlePreviewModalBackdrop");
    onPlay(variants[idx], asymmetric, rotate);
  };

  // Рейтинг — любой вариант сложности резолвится сервером в ту же группу
  // (см. server.js, ratingSummary по image_file), первого достаточно.
  // Не блокирует открытие модалки — просто появляется, когда придёт.
  const ratingEl = document.getElementById("puzzlePreviewRating");
  ratingEl.hidden = true;
  roomFetch(`/api/puzzles/${encodeURIComponent(variants[0].id)}/rating`)
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data || !data.count) return;
      ratingEl.hidden = false;
      ratingEl.textContent = `★ ${data.average.toFixed(1)} (${data.count} ${tn(data.count, ["оценка", "оценки", "оценок"], ["rating", "ratings"])})`;
    })
    .catch(() => {});

  openModal("puzzlePreviewModalBackdrop");
}
bindModal("puzzlePreviewModalBackdrop", null, "puzzlePreviewModalClose");

/* ───────────────────────── страница пазла (/puzzle/:id) ─────────────────────────
 * Полноценная страница вместо клика по карточке в библиотеке (см. план
 * «Страница пазла вместо превью-модалки», зарегистрирована в route() ниже)
 * — теперь открывается сама (URL меняется, страница индексируется/шарится
 * отдельно от /table/:id, см. server.js applySeoOverride), а не модалка
 * поверх библиотеки. Кнопка «За стол» с самой карточки (buildCard) убрана
 * — клик по карточке ведёт прямо сюда, НО только вне комнаты (см. buildCard:
 * внутри комнаты карточка по-прежнему открывает openPuzzlePreviewModal выше
 * — там речь о старте сеанса В ЭТОЙ комнате, а не о переходе на публичную
 * страницу).
 *
 * Вёрстка — см. план «Нормальная вёрстка страницы пазла»: НЕ модалка
 * превью, вставленная в поток (так было раньше — узкая карточка 34rem,
 * sr-only h1, плавающая шапка), а обычная страница по образцу остальных
 * (renderCategoryPage/renderProfile — .library-head-подобная шапка,
 * .puzzle-grid ниже), просто с двумя колонками (картинка/инфо, см.
 * .puzzle-page в styles.css). h1 — настоящий, видимый (был sr-only только
 * пока это была модалка, где заголовок дублировала .puzzle-preview-caption
 * рядом с рейтингом — тут он один и должен быть виден). Добавлены: крошки
 * до категории, тег категории (ссылка), интерактивный рейтинг
 * (buildRatingWidget — тот же виджет, что на окне победы, можно оценить
 * пазл и не решив его, роут это уже поддерживал анонимно) и блок «Ещё в
 * категории X» — реальные внутренние ссылки на похожие пазлы, не только
 * ради красоты: без него страница пазла — тупик для краулера. */
async function renderPuzzlePage(root, id, signal) {
  root.innerHTML = `<p class="state-note">${t("Загружаем…")}</p>`;
  let data, categories, allPuzzles;
  try {
    [data, categories, allPuzzles] = await Promise.all([
      getPuzzleWithVariants(id),
      getCategories().catch(() => []),
      getPuzzles("").catch(() => []),
      ensureDisplayTitleCache(),
    ]);
  } catch (e) {
    if (signal.aborted) return;
    root.innerHTML = `<p class="state-note">${e.message === "not found" ? t("Такого пазла нет.") : t("Не удалось загрузить пазл — обновите страницу.")}</p>`;
    return;
  }
  if (signal.aborted) return;

  const { puzzle: p, variants } = data;
  const displayTitle = puzzleDisplayTitle(p);
  const pieces = p.gridRows * p.gridCols;
  // Дословно та же формула, что и SEO title/description для /puzzle/:id на
  // сервере (см. server.js, serveApp/applySeoOverride) — после клиентского
  // перехода (SPA, без полной перезагрузки) вкладка должна показать тот же
  // текст, что и при свежей загрузке этого же URL напрямую.
  setPageMeta(
    `Пазл «${p.title}» онлайн — собрать бесплатно | Что собираем?`,
    `Собери пазл «${p.title}» онлайн бесплатно, без регистрации и скачивания — ${pieces} ${plural(pieces, "деталь", "детали", "деталей")}, прямо в браузере.`,
  );

  // Категория — только approved (categories — GET /api/categories, отдаёт
  // только их) и только если сама категория ещё существует (Admin мог её
  // удалить, а category_id у пазла — нет, см. server.js). Пользовательские
  // публикации тоже могут быть с категорией (выбирается при публикации,
  // см. openPublishModal) — то же поле, той же формулой.
  const category = p.categoryId ? categories.find(c => c.id === p.categoryId) : null;

  root.innerHTML = `
    <nav class="puzzle-page-crumbs" aria-label="${t("Хлебные крошки")}">
      <a href="/">${t("Библиотека")}</a>
      ${category ? `<span aria-hidden="true">/</span><a id="puzzlePageCrumbCat" href="#"></a>` : ""}
    </nav>
    <div class="puzzle-page">
      <img class="puzzle-page-image" id="puzzlePageImage" alt="">
      <div class="puzzle-page-info">
        <div class="puzzle-page-title-row">
          <h1 id="puzzlePageTitle"></h1>
          <button class="icon-btn" id="puzzlePageShareBtn" type="button" title="${t("Скопировать ссылку на пазл")}" aria-label="${t("Скопировать ссылку на пазл")}">${SHARE_ICON}</button>
        </div>
        ${category ? `<a class="puzzle-page-tag" id="puzzlePageTag" href="#"></a>` : ""}
        <a class="puzzle-card-author" id="puzzlePageAuthor" href="#" hidden></a>
        <p class="puzzle-page-rating-summary" id="puzzlePageRatingSummary" hidden></p>
        <div class="puzzle-page-rate" id="puzzlePageRate"></div>
        <div class="puzzle-page-mystats" id="puzzlePageMyStats" hidden>
          <h2 class="puzzle-page-subhead" id="puzzlePageMyStatsHeading"></h2>
        </div>
        <div class="puzzle-page-sep"></div>
        <h2 class="puzzle-page-subhead">${t("Сложность")}</h2>
        <div class="difficulty-grid" id="puzzlePageDifficultyGrid"></div>
        <label class="checkbox-row">
          <input type="checkbox" id="puzzlePageAsymmetric">
          <span>${t("Ассиметричная форма деталей — сложнее, детали неровные")}</span>
        </label>
        <label class="checkbox-row">
          <input type="checkbox" id="puzzlePageRotate">
          <span>${t("Повороты деталей — детали нужно ещё повернуть, не только сложить")}</span>
        </label>
        <button class="btn filled full" id="puzzlePagePlayBtn" type="button">${t("За стол")}</button>
      </div>
    </div>
    <section class="puzzle-page-related" id="puzzlePageRelated" hidden>
      <h2 id="puzzlePageRelatedHeading"></h2>
      <div class="puzzle-grid" id="puzzlePageRelatedGrid"></div>
    </section>`;

  const img = $(root, "#puzzlePageImage");
  img.src = p.imageUrl; img.alt = displayTitle;
  $(root, "#puzzlePageTitle").textContent = displayTitle;

  if (category) {
    const name = categoryDisplayName(category);
    const href = `/category/${encodeURIComponent(category.slug)}`;
    for (const el of [$(root, "#puzzlePageCrumbCat"), $(root, "#puzzlePageTag")]) {
      el.href = href;
      el.textContent = name;
    }
  }

  // Автор — то же условие, что у buildCard/openPuzzlePreviewModal: только у
  // ОДОБРЕННЫХ публикаций.
  const authorEl = $(root, "#puzzlePageAuthor");
  if (p.uploaderUsername && p.moderationStatus === "approved") {
    authorEl.hidden = false;
    authorEl.href = `/profile/${encodeURIComponent(p.uploaderUserId)}`;
    authorEl.textContent = `${t("Добавил:")} ${p.uploaderUsername}`;
  } else {
    authorEl.hidden = true;
  }

  // Своя статистика по этому пазлу (см. план «Статистика сборки») —
  // показываем, только если для ТЕКУЩЕГО зрителя есть хоть какой-то
  // прогресс по любому уровню сложности этой группы. У вошедшего — уже
  // готовый myStats в ответе API (сервер сам выбрал завершённый/самый
  // свежий вариант среди всех сложностей, см. server.js). У гостя прогресс
  // живёт в localStorage браузера и серверу не виден вовсе — досчитываем
  // то же самое тут же, перебором по variants (их разумное число, до
  // полутора десятков). Строго по auth.isAuthenticated(), не просто
  // "!data.myStats" — иначе у вошедшего без прогресса эта ветка ошибочно
  // подхватила бы чужой/устаревший локальный прогресс того же браузера.
  let myStats = data.myStats;
  if (!myStats && !auth.isAuthenticated()) {
    const guestRows = variants
      .map(v => { const lp = localProgress(v.id); return lp ? { ...lp, puzzleId: v.id } : null; })
      .filter(Boolean);
    if (guestRows.length) {
      const completedRows = guestRows.filter(r => r.completedAt).sort((a, b) => b.completedAt - a.completedAt);
      myStats = completedRows[0] || [...guestRows].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    }
  }
  if (myStats) {
    const block = $(root, "#puzzlePageMyStats");
    block.hidden = false;
    const variantIdx = Math.max(0, variants.findIndex(v => v.id === myStats.puzzleId));
    const variant = variants[variantIdx] || variants[0];
    const levelLabel = t(DIFFICULTY_LABELS[variantIdx]) || `${t("Уровень")} ${variantIdx + 1}`;
    if (myStats.completedAt) {
      $(root, "#puzzlePageMyStatsHeading").textContent = t("Вы уже собирали этот пазл");
      const stats = buildStatsBlock(myStats.startedAt, myStats.completedAt, myStats.piecesTotal);
      const dateP = document.createElement("p");
      dateP.className = "puzzle-page-mystats-date";
      dateP.textContent = `${fmtDate(myStats.completedAt)} — ${levelLabel}`;
      const replayBtn = document.createElement("a");
      replayBtn.className = "btn outlined full";
      replayBtn.href = `/table/${encodeURIComponent(variant.id)}`;
      replayBtn.textContent = t("Собрать ещё раз");
      block.append(stats, dateP, replayBtn);
    } else {
      $(root, "#puzzlePageMyStatsHeading").textContent = t("Вы уже начали этот пазл");
      const progressP = document.createElement("p");
      progressP.className = "puzzle-page-mystats-date";
      progressP.textContent = `${myStats.piecesPlaced}/${myStats.piecesTotal} ${tn(myStats.piecesTotal, ["деталь", "детали", "деталей"], ["piece", "pieces"])} — ${levelLabel}`;
      const continueBtn = document.createElement("a");
      continueBtn.className = "btn filled full";
      continueBtn.href = `/table/${encodeURIComponent(variant.id)}`;
      continueBtn.textContent = t("Продолжить");
      block.append(progressP, continueBtn);
    }
  }

  const choice = { idx: 0 };
  renderDifficultyGrid($(root, "#puzzlePageDifficultyGrid"), variants, choice);

  // Поделиться — только у ПУБЛИЧНОГО пазла (ownerUserId===null, см.
  // openPuzzlePreviewModal): своё ещё не опубликованное фото сюда обычно и
  // не попадает (API отдаёт 404 не-автору), но сам автор, глядя на
  // собственную заявку, тоже не должен видеть бесполезную ссылку.
  const shareBtn = $(root, "#puzzlePageShareBtn");
  shareBtn.hidden = !!p.ownerUserId;
  if (!p.ownerUserId) {
    bindShareButton(shareBtn, () => `${location.origin}/puzzle/${encodeURIComponent(variants[0].id)}`);
  }

  $(root, "#puzzlePagePlayBtn").addEventListener("click", () => {
    const variant = variants[choice.idx] || variants[0];
    const asymmetric = $(root, "#puzzlePageAsymmetric").checked;
    const rotate = $(root, "#puzzlePageRotate").checked;
    navigate(`/table/${encodeURIComponent(variant.id)}?shape=${asymmetric ? "asym" : "normal"}&rotate=${rotate ? "1" : "0"}`);
  }, { signal });

  // Рейтинг — сводка текстом (среднее+число оценок, любой вариант сложности
  // резолвится сервером в ту же группу по image_file, первого достаточно) +
  // сам виджет buildRatingWidget под ней — можно оценить пазл прямо здесь,
  // тот же приём, что на окне победы (см. план «Оценка пазла на окне
  // победы»), сюда — не блокирует остальную страницу, звёзды появляются
  // сразу, сводка — когда придёт число.
  const ratingSummaryEl = $(root, "#puzzlePageRatingSummary");
  roomFetch(`/api/puzzles/${encodeURIComponent(variants[0].id)}/rating`)
    .then(r => r.ok ? r.json() : null)
    .then(rating => {
      if (signal.aborted || !rating || !rating.count) return;
      ratingSummaryEl.hidden = false;
      ratingSummaryEl.innerHTML = `★ <b>${rating.average.toFixed(1)}</b> · ${rating.count} ${tn(rating.count, ["оценка", "оценки", "оценок"], ["rating", "ratings"])}`;
    })
    .catch(() => {});
  $(root, "#puzzlePageRate").appendChild(buildRatingWidget(variants[0], signal));

  // Похожие пазлы той же категории — реальные внутренние ссылки, страница
  // не должна быть тупиком для посетителя/краулера. Своя группа исключена
  // по imageUrl (тот же ключ, что и puzzleGroupKey/groupPuzzles), лимит 6 —
  // это витрина, не полный список (за полным — сама ссылка на категорию,
  // см. тег выше).
  if (category) {
    const groups = groupPuzzles(allPuzzles.filter(x => !x.uploaderUserId));
    const related = filterGroupsByCategory(groups, category.id).filter(g => g.imageUrl !== p.imageUrl).slice(0, 6);
    if (related.length) {
      const section = $(root, "#puzzlePageRelated");
      section.hidden = false;
      $(root, "#puzzlePageRelatedHeading").textContent = getLang() === "en"
        ? `More in "${categoryDisplayName(category)}"`
        : `Ещё в категории «${categoryDisplayName(category)}»`;
      const grid = $(root, "#puzzlePageRelatedGrid");
      for (const g of related) grid.appendChild(buildCard(g));
    }
  }
}

/* ───────────────────────── публикация своего фото ─────────────────────────
 * См. план «Модерация загруженных фото» — отдельное, более строгое согласие,
 * не то же самое, что чекбокс при обычной загрузке в комнату (mountUploadForm).
 * Тот же приём, что и у openDifficultyModal выше: статичная разметка в
 * index.html, "pending"-переменная переносит контекст между открытием и
 * подтверждением. */
let pendingPublishId = null;
async function openPublishModal(id, title, onDone) {
  document.getElementById("publishModalTitle").textContent = `${t("Опубликовать")} «${title}»`;
  const list = document.getElementById("publishCategoryList");
  list.innerHTML = [...PROHIBITED_TIER_A, ...PROHIBITED_TIER_B].map(c => `<li>${t(c)}</li>`).join("");
  document.getElementById("publishConsent").checked = false;
  document.getElementById("publishNewCategoryName").value = "";
  document.getElementById("publishError").hidden = true;
  // Категория — одиночный выбор через <select> (см. план «Один пазл — одна
  // категория»), список — только approved (pending пока не выбрать, их ещё
  // не видно в публичном GET /api/categories). Пустая опция — категория по
  // умолчанию, системная «Пользовательские» (см. server.js, POST
  // .../publish): выбор существующей категории или своей через
  // publishNewCategoryName ниже её заменяет, а не дополняет.
  const categoriesBox = document.getElementById("publishLibraryCategories");
  categoriesBox.innerHTML = `<p class="state-note">${t("Загрузка категорий…")}</p>`;
  try {
    const categories = await getCategories();
    categoriesBox.innerHTML = categories.length
      ? `<select class="text-input" id="publishCategorySelect">
          <option value="">${t("Без категории (по умолчанию — «Пользовательские»)")}</option>
          ${categories.map(c => `<option value="${c.id}">${categoryDisplayName(c)}</option>`).join("")}
        </select>`
      : "";
  } catch { categoriesBox.innerHTML = ""; }
  pendingPublishId = { id, onDone };
  openModal("publishModalBackdrop");
}
bindModal("publishModalBackdrop", null, "publishModalClose");
document.getElementById("publishConfirmBtn").addEventListener("click", async () => {
  if (!pendingPublishId) return;
  const errEl = document.getElementById("publishError");
  errEl.hidden = true;
  if (!document.getElementById("publishConsent").checked) {
    errEl.textContent = t("Нужно подтвердить согласие с правилами публикации.");
    errEl.hidden = false;
    return;
  }
  const { id, onDone } = pendingPublishId;
  const categorySelect = document.getElementById("publishCategorySelect");
  const categoryId = categorySelect ? categorySelect.value : "";
  const newCategoryName = document.getElementById("publishNewCategoryName").value.trim();
  const btn = document.getElementById("publishConfirmBtn");
  btn.disabled = true;
  try {
    await publishPuzzle(id, { categoryId, newCategoryName });
    trackGoal("photo_submitted");
    closeModal("publishModalBackdrop");
    pendingPublishId = null;
    onDone();
  } catch (err) {
    errEl.textContent = t("Не удалось отправить на модерацию — попробуйте ещё раз.");
    errEl.hidden = false;
  }
  btn.disabled = false;
});

/* ───────────────────────── хранилище гостя ───────────────────────── */
const localKey = id => `puzzle_progress_${id}`;
function localProgress(id) {
  try { return JSON.parse(localStorage.getItem(localKey(id)) || "null"); } catch { return null; }
}

/* ───────────────────────── общие данные ───────────────────────── */
// Кэш по ключу roomId (пустая строка — соло/без комнаты): свои фото видны
// только в комнате, где загружены (см. server.js, ALTER TABLE room_id) —
// общий кэш без ключа отдавал бы список одной комнаты в другую.
async function getPuzzles(roomId) {
  const key = roomId || "";
  if (puzzlesCache.has(key)) return puzzlesCache.get(key);
  const qs = roomId ? `?roomId=${encodeURIComponent(roomId)}` : "";
  const res = await roomFetch(`/api/puzzles${qs}`);
  if (!res.ok) throw new Error("puzzles fetch failed");
  const data = await res.json();
  puzzlesCache.set(key, data);
  return data;
}

/** Один пазл со всеми уровнями сложности своей группы — для страницы пазла
 *  (см. renderPuzzlePage), без кэша: страница открывается по прямой ссылке
 *  (шаринг/поисковик), не всегда после уже прогретого puzzlesCache, а сам
 *  список из одной группы копить в общем кэше не стоит той сложности.
 *  Бросает при 404/сети — вызывающий код (renderPuzzlePage) сам решает,
 *  как показать «не найдено». */
async function getPuzzleWithVariants(id) {
  const res = await roomFetch(`/api/puzzles/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(res.status === 404 ? "not found" : "puzzle fetch failed");
  return res.json();
}

/** Список категорий для карусели над библиотекой (см. план «Категории
 *  пазлов в библиотеке») — без кэша: список короткий, почти не меняется,
 *  а кэш вроде puzzlesCache пришлось бы отдельно инвалидировать при
 *  каждом изменении в Admin, что не окупается для пары запросов за сессию. */
async function getCategories() {
  const res = await fetch("/api/categories");
  if (!res.ok) throw new Error("categories fetch failed");
  return res.json();
}

/** Ключ группировки — та же формула, что и в groupPuzzles ниже (общий
 *  imageUrl, плюс владелец для ещё не опубликованных своих фото). */
function puzzleGroupKey(p) {
  return p.ownerUserId ? `${p.ownerUserId}:${p.imageUrl}` : p.imageUrl;
}

/** Кэш «ключ группы → готовая подпись» для вычисляемых названий
 *  библиотечных пазлов вида «Категория #N» (см. план «Один пазл — одна
 *  категория» — номер считается на лету по текущему порядку среди пазлов
 *  той же категории, не хранится в БД). Пользовательские публикации
 *  (uploaderUserId) в подсчёт не входят и своих номеров не получают —
 *  у них остаётся собственное title (см. puzzleDisplayTitle). Прогревается
 *  лениво, инвалидируется вместе с puzzlesCache (см. invalidatePuzzlesCache). */
let displayTitleCache = null;
function invalidatePuzzlesCache() {
  puzzlesCache.clear();
  displayTitleCache = null;
}
async function ensureDisplayTitleCache() {
  if (displayTitleCache) return displayTitleCache;
  const [puzzles, categories] = await Promise.all([getPuzzles(""), getCategories()]);
  const catById = new Map(categories.map(c => [c.id, c]));
  const counters = new Map();
  const cache = new Map();
  for (const group of groupPuzzles(puzzles.filter(p => !p.uploaderUserId))) {
    if (!group.categoryId) continue;
    const cat = catById.get(group.categoryId);
    if (!cat) continue;
    const n = (counters.get(group.categoryId) || 0) + 1;
    counters.set(group.categoryId, n);
    cache.set(puzzleGroupKey(group), { cat, n });
  }
  displayTitleCache = cache;
  return cache;
}
/** Синхронная — рассчитана на уже прогретый кэш (см. вызовы
 *  ensureDisplayTitleCache в renderLibrary/renderCategoryPage/renderTable/
 *  renderRoom/renderRoomTable). Пользовательские публикации и пазлы без
 *  категории просто возвращают собственное title (мягкий fallback, тот же
 *  принцип, что у t() при отсутствии перевода). categoryDisplayName внутри
 *  сама учитывает текущий язык — переключение языка не требует
 *  перестройки этого кэша (см. setLang, который зовёт route()). */
function puzzleDisplayTitle(p) {
  if (p.uploaderUserId || !displayTitleCache) return p.title;
  const info = displayTitleCache.get(puzzleGroupKey(p));
  return info ? `${categoryDisplayName(info.cat)} #${info.n}` : p.title;
}

// По индексу, не по точному числу деталей: gridForPieceTarget округляет
// rows/cols независимо, поэтому реальный total у пресета «108» иногда
// получается 104 или 112 — сверка по значению иногда промахивалась бы
// мимо ярлыка. variants всегда отсортирован по возрастанию и всегда
// получен из PIECE_PRESETS в этом порядке, так что порядковый номер
// надёжнее самого числа деталей.
// «+»-уровни (см. план «Больше шагов сложности», PIECE_PRESETS в server.js) —
// промежуточный шаг между соседними названными уровнями, не отдельное
// название: 24 деталей ближе по духу к «Легко», чем к «Средне», просто
// капельку сложнее.
const DIFFICULTY_LABELS = [
  "Легко", "Легко+", "Средне", "Средне+", "Сложно", "Сложно+",
  "Эксперт", "Эксперт+", "Мастер", "Мастер+", "Легенда",
];

/** Сводит отдельные строки-варианты одной загрузки (общий imageUrl +
 *  владелец) в одну карточку с массивом .variants, отсортированным от
 *  лёгкого к сложному. У встроенных пазлов (ownerUserId нет) — группа
 *  из одного варианта, там ничего не меняется внешне. */
function groupPuzzles(list) {
  const groups = new Map();
  for (const p of list) {
    // imageUrl всегда, не p.id: у встроенных пазлов (Холмы/Лес/Горы) теперь
    // тоже несколько уровней сложности (см. server.js, BUILTIN_IMAGES), у
    // каждого свой уникальный id, но общий imageUrl — тот же общий ключ
    // группировки, что уже работал для своих фото.
    const key = p.ownerUserId ? `${p.ownerUserId}:${p.imageUrl}` : p.imageUrl;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups.values()].map(variants => {
    variants.sort((a, b) => a.gridRows * a.gridCols - b.gridRows * b.gridCols);
    return { ...variants[0], variants };
  });
}

/** Общий фильтр групп по категории — использует и карусель на главной
 *  (renderLibrary), и страница отдельной категории (renderCategoryPage),
 *  см. план «Прямые ссылки + страница категорий». */
function filterGroupsByCategory(groups, categoryId) {
  return groups.filter(p => p.categoryId === categoryId);
}

/** Верхний потолок стороны выше, чем у фото Trip (2000 против 1600) —
 *  картинка режется на десятки кусков и разглядывается вблизи при зуме. */
async function shrinkForPuzzle(file) {
  const bitmap = await createImageBitmap(file);
  const MAX_SIDE = 2000;
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.86));
  return { blob, width: w, height: h };
}

/** Комнаты работают и без входа (см. server.js/getOrCreateAnonIdentity) —
 *  anonymous identity живёт в HttpOnly cookie, не в JWT, поэтому
 *  auth.fetch (бросает AuthRequiredError без токена, assets/auth-client.js)
 *  для комнатных запросов не годится анониму. Обычный fetch на
 *  same-origin сам шлёт cookies, ничего дополнительно прокидывать не
 *  нужно. НЕ использовать для того, что реально требует входа (загрузка
 *  своих фото — uploadPuzzlePhoto ниже остаётся на auth.fetch). */
function roomFetch(url, opts) {
  return auth.isAuthenticated() ? auth.fetch(url, opts) : fetch(url, opts);
}

/** Список СВОИХ комнат (см. план «Добавление в комнату», дропдаун на
 *  карточке библиотеки) — работает и без входа, через анонимную cookie-
 *  личность (roomFetch), тот же роут, что и renderRoomsList. */
async function getRooms() {
  const res = await roomFetch("/api/rooms");
  if (!res.ok) throw new Error("rooms fetch failed");
  return res.json();
}

async function uploadPuzzlePhoto(file, title, roomId) {
  const { blob, width, height } = await shrinkForPuzzle(file);
  // consent=1 — обязательное согласие с запрещёнными категориями (см. план
  // «Модерация загруженных фото»): форма физически не даёт сюда попасть без
  // отмеченной галочки (mountUploadForm ниже), но сервер всё равно
  // перепроверяет сам — клиент не источник доверия.
  const qs = new URLSearchParams({ w: String(width), h: String(height), title: title || t("Мой пазл"), roomId, consent: "1" });
  const res = await auth.fetch(`/api/puzzles?${qs}`, {
    method: "POST", headers: { "Content-Type": blob.type || "image/jpeg" }, body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "upload failed");
  invalidatePuzzlesCache(); // библиотека изменилась — старый кэш врёт
  return data;
}

/** POST /api/rooms/:id/sessions с готовой обработкой гонки (кто-то уже
 *  начал сеанс раньше) — редиректит на уже существующий вместо ошибки.
 *  Общий код для пикера, формы загрузки, экрана «уже собран» и истории. */
async function startRoomSession(roomId, puzzleId, asymmetric, rotate) {
  const res = await roomFetch(`/api/rooms/${encodeURIComponent(roomId)}/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ puzzleId, asymmetric: !!asymmetric, rotate: !!rotate }),
  });
  const data = await res.json();
  if (res.status === 409 && data.session) return data.session.id;
  if (!res.ok) {
    const err = new Error(data.error || "start session failed");
    if (typeof data.limit === "number") err.limit = data.limit;
    throw err;
  }
  return data.id;
}

async function deletePuzzle(id) {
  const res = await auth.fetch(`/api/puzzles/${encodeURIComponent(id)}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || "delete failed");
  invalidatePuzzlesCache();
}

/** Отправка своего фото на публикацию в общую библиотеку (см. план
 *  «Модерация загруженных фото») — отдельное, более строгое согласие, не то
 *  же самое, что consent=1 при обычной загрузке в комнату. */
async function publishPuzzle(id, { categoryId, newCategoryName } = {}) {
  const res = await auth.fetch(`/api/puzzles/${encodeURIComponent(id)}/publish`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ consent: true, categoryId: categoryId || undefined, newCategoryName: newCategoryName || undefined }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "publish failed");
  invalidatePuzzlesCache();
  return data;
}

/** Добавляет библиотечный пазл (все уровни сложности сразу — ключ на
 *  сервере это image_file группы, один вариант id достаточен) в список
 *  явно добавленного для этой комнаты (см. план «Библиотека в комнате —
 *  по добавлению, не по умолчанию», server.js/room_added_puzzles). */
async function addPuzzleToRoom(roomId, variants) {
  await roomFetch(`/api/rooms/${encodeURIComponent(roomId)}/added-puzzles`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ puzzleId: variants[0].id }),
  });
  invalidatePuzzlesCache();
}

/** Убирает библиотечный пазл (все уровни сложности сразу) из списка
 *  добавленного для этой комнаты — сам пазл остаётся глобально доступным,
 *  просто перестаёт быть виден в ЭТОЙ комнате. Своих фото это не касается —
 *  для них есть настоящее удаление, deletePuzzle выше. */
async function removePuzzleFromRoom(roomId, variants) {
  await roomFetch(`/api/rooms/${encodeURIComponent(roomId)}/added-puzzles/${encodeURIComponent(variants[0].id)}`, { method: "DELETE" });
  invalidatePuzzlesCache();
}

/** DELETE /api/rooms/:id/sessions/:sessionId — освобождает слот из лимита
 *  MAX_ACTIVE_SESSIONS_PER_ROOM (активный, но пустой сеанс) или убирает
 *  завершённый сеанс из истории. Сервер отбивает 409-м, если сеанс сейчас
 *  активный и за столом реально кто-то есть — тогда бросаем понятную ошибку,
 *  вызывающий код (renderRoom) ловит её текстом. */
async function deleteRoomSession(roomId, sessionId) {
  const res = await roomFetch(`/api/rooms/${encodeURIComponent(roomId)}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  if (res.status === 409) throw new Error("table not empty");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "delete session failed");
}

/** DELETE /api/rooms/:id/members/:userId — только владелец комнаты (сервер
 *  сам это проверяет по member.role, здесь только пробрасываем ошибку). */
async function removeRoomMember(roomId, userId) {
  const res = await roomFetch(`/api/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "remove member failed");
}

/** DELETE /api/rooms/:id — удаляет комнату целиком (только владелец, сервер
 *  сам проверяет member.role). Каскад чистит БД, сервер же рвёт живые
 *  WS-подключения — здесь просто пробрасываем ошибку и уходим на /rooms. */
async function deleteRoom(roomId) {
  const res = await roomFetch(`/api/rooms/${encodeURIComponent(roomId)}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "delete room failed");
}

/** Вставляет форму загрузки в контейнер, вызывает onDone({title, variants})
 *  при успехе — один аплоад сразу заводит все 4 уровня сложности (см.
 *  README «Свои фото»), выбора числа деталей тут больше нет. Используется
 *  только в пикере комнаты (renderRoom) — своих фото в соло-библиотеке
 *  больше нет (см. renderLibrary). roomId — граница видимости результата
 *  (см. server.js, room_id): фото доступно только за столом ЭТОЙ комнаты. */
function mountUploadForm(container, roomId, onDone) {
  container.innerHTML = `
    <form class="upload-form" id="uploadForm">
      <input class="text-input" id="uploadTitle" type="text" maxlength="80" placeholder="${t("Название — необязательно")}">
      <input type="file" id="uploadFile" accept="image/*" required>
      <div class="upload-consent">
        <p class="upload-consent-title">${t("Нельзя загружать фото, которые относятся к следующим категориям:")}</p>
        <ul class="upload-consent-list">${PROHIBITED_TIER_A.map(c => `<li>${t(c)}</li>`).join("")}</ul>
        <label class="upload-consent-check">
          <input type="checkbox" id="uploadConsent" required>
          ${t("Я подтверждаю, что несу ответственность за загруженное фото и что оно не относится к перечисленным категориям")}
        </label>
      </div>
      <button class="btn filled" type="submit">${t("Собрать из фото")}</button>
      <p class="state-note" id="uploadError" hidden></p>
    </form>`;
  const form = $(container, "#uploadForm");
  const errEl = $(container, "#uploadError");
  form.addEventListener("submit", async e => {
    e.preventDefault();
    errEl.hidden = true;
    const file = $(form, "#uploadFile").files[0];
    if (!file) { errEl.textContent = t("Выберите файл"); errEl.hidden = false; return; }
    const submitBtn = $(form, "button[type=submit]");
    submitBtn.disabled = true;
    try {
      const title = $(form, "#uploadTitle").value.trim();
      const result = await uploadPuzzlePhoto(file, title, roomId);
      onDone(result);
      form.reset();
      submitBtn.disabled = false;
    } catch (err) {
      errEl.textContent = err.message === "not an image" ? t("Файл не похож на изображение (JPEG/PNG/WebP).")
        : err.message === "too large" ? t("Файл слишком большой даже после сжатия.")
        : t("Не удалось загрузить — попробуйте ещё раз.");
      errEl.hidden = false;
      submitBtn.disabled = false;
    }
  });
}

/** Панель «Из библиотеки» внутри модалки «Добавить пазл» (см. index.html,
 *  #addPuzzleLibraryMount) — вся общая библиотека (не только эта комната,
 *  см. план «Библиотека в комнате — по добавлению, не по умолчанию»), с
 *  фильтром по категории (выпадайка) и кнопкой «Добавить» на каждой
 *  карточке. addedImageUrls — Set imageUrl уже видимых в этой комнате
 *  пазлов (см. renderRoom) — уже добавленные помечаются disabled, а не
 *  прячутся: так понятнее, что повторно жать незачем, чем если бы карточка
 *  просто исчезала. onAdded(group) зовётся сразу после успешного добавления
 *  — renderRoom сам решает, как дорисовать карточку в настоящую сетку
 *  комнаты позади модалки. */
async function renderAddPuzzleLibrary(container, roomId, addedImageUrls, signal, onAdded) {
  container.innerHTML = `<p class="state-note">${t("Загрузка…")}</p>`;
  let puzzles, categories;
  try {
    [puzzles, categories] = await Promise.all([getPuzzles(), getCategories().catch(() => []), ensureDisplayTitleCache()]);
  } catch {
    if (!signal.aborted) container.innerHTML = `<p class="state-note">${t("Не удалось загрузить библиотеку.")}</p>`;
    return;
  }
  if (signal.aborted) return;

  const allGroups = groupPuzzles(puzzles.filter(p => !p.ownerUserId));
  const counts = new Map();
  for (const g of allGroups) if (g.categoryId) counts.set(g.categoryId, (counts.get(g.categoryId) || 0) + 1);
  const nonEmptyCategories = categories.filter(c => counts.get(c.id) > 0);

  if (!allGroups.length) {
    container.innerHTML = `<p class="state-note">${t("В библиотеке пока нет ни одного пазла.")}</p>`;
    return;
  }

  container.innerHTML = `
    <div class="add-puzzle-category-row">
      <label for="addPuzzleCategorySelect">${t("Категория")}</label>
      <select class="text-input" id="addPuzzleCategorySelect">
        <option value="">${t("Все категории")}</option>
        ${nonEmptyCategories.map(c => `<option value="${c.id}">${categoryDisplayName(c)} (${counts.get(c.id)})</option>`).join("")}
      </select>
    </div>
    <div class="add-puzzle-grid" id="addPuzzleGrid"></div>`;
  const select = $(container, "#addPuzzleCategorySelect");
  const gridEl = $(container, "#addPuzzleGrid");

  function paint() {
    const catId = select.value;
    const shown = catId ? allGroups.filter(g => g.categoryId === catId) : allGroups;
    gridEl.innerHTML = "";
    if (!shown.length) {
      gridEl.innerHTML = `<p class="state-note">${t("Пусто.")}</p>`;
      return;
    }
    for (const g of shown) {
      const card = document.createElement("div");
      card.className = "add-puzzle-card";
      const img = document.createElement("img");
      img.src = g.imageUrl; img.alt = puzzleDisplayTitle(g); img.loading = "lazy";
      const title = document.createElement("div");
      title.className = "title"; title.textContent = puzzleDisplayTitle(g);
      const btn = document.createElement("button");
      btn.className = "btn tonal sm"; btn.type = "button";
      const already = addedImageUrls.has(g.imageUrl);
      btn.textContent = already ? t("Уже добавлен") : t("Добавить");
      btn.disabled = already;
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await addPuzzleToRoom(roomId, g.variants);
          addedImageUrls.add(g.imageUrl);
          btn.textContent = t("Уже добавлен");
          onAdded(g);
        } catch {
          btn.disabled = false;
          alert(t("Не удалось добавить."));
        }
      }, { signal });
      card.append(img, title, btn);
      gridEl.appendChild(card);
    }
  }
  select.addEventListener("change", paint, { signal });
  paint();
}

/** Прогресс по пазлу для карточки библиотеки: сервер для вошедшего, localStorage для гостя. */
async function progressFor(p) {
  if (auth.isAuthenticated()) {
    try {
      const res = await auth.fetch(`/api/puzzles/${encodeURIComponent(p.id)}/progress`);
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }
  return localProgress(p.id);
}

/** Незавершённые сборки для «Продолжить сборку» над библиотекой (см. план)
 *  — вошедшему один bulk-запрос (GET /api/puzzles/progress, см. server.js),
 *  гостю — то же самое из localStorage, дополненное метаданными (title/
 *  imageUrl) из уже загруженного списка пазлов allPuzzles (тем же id).
 *  Публикации других пользователей (ownerUserId) исключены — свои фото,
 *  загруженные в комнату, вне контекста этой комнаты не открываются вовсе
 *  (см. renderTable), продолжить их отсюда всё равно нельзя. */
async function inProgressPuzzles(allPuzzles) {
  if (auth.isAuthenticated()) {
    try {
      const res = await auth.fetch("/api/puzzles/progress");
      if (!res.ok) return [];
      return await res.json();
    } catch { return []; }
  }
  const out = [];
  for (const p of allPuzzles) {
    if (p.ownerUserId) continue;
    const progress = localProgress(p.id);
    if (progress && progress.piecesPlaced > 0 && !progress.completedAt) {
      out.push({
        puzzleId: p.id, title: p.title, imageUrl: p.imageUrl,
        uploaderUserId: p.uploaderUserId, categoryId: p.categoryId,
        piecesPlaced: progress.piecesPlaced, piecesTotal: progress.piecesTotal,
        updatedAt: progress.updatedAt || 0,
      });
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

const IN_PROGRESS_PAGE_SIZE = 5;

/** Карточка одной незавершённой сборки — переиспользует классы .puzzle-card
 *  целиком (thumb/badge/title-row/play), тот же вид, что и у обычной
 *  карточки библиотеки, только картинка теперь есть (см. план — раньше
 *  список был текстовыми строками .history-row без превью). Кнопка
 *  удаления — не buildCard (там куча лишнего: меню «…», автор, статус
 *  модерации, выбор сложности) — своя маленькая, одно действие,
 *  тем же приёмом наведения/фокуса, что у .puzzle-card>.menu-wrap
 *  (см. CSS, .progress-card-delete). onDeleted вызывается ПОСЛЕ того, как
 *  прогресс реально стёрт — рендер страницы сам решает, что дальше. */
function buildInProgressCard(ip, signal, onDeleted) {
  const card = document.createElement("article");
  card.className = "puzzle-card";
  card.innerHTML = `
    <div class="puzzle-card-thumb">
      <img alt="" loading="lazy">
      <span class="puzzle-card-badge"></span>
    </div>
    <button class="icon-btn xs progress-card-delete" type="button" title="${t("Удалить прогресс")}" aria-label="${t("Удалить прогресс")}">
      <svg class="icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
    <div class="puzzle-card-body">
      <div class="puzzle-card-title-row">
        <h3 class="puzzle-card-title"></h3>
        <button class="btn filled sm" type="button">${t("За стол")}</button>
      </div>
      <p class="puzzle-card-meta"></p>
    </div>`;
  const img = $(card, "img");
  img.src = ip.imageUrl;
  img.alt = puzzleDisplayTitle(ip);
  $(card, ".puzzle-card-title").textContent = puzzleDisplayTitle(ip);
  const badge = $(card, ".puzzle-card-badge");
  badge.textContent = `${Math.round((ip.piecesPlaced / ip.piecesTotal) * 100)}%`;
  badge.hidden = false;
  $(card, ".puzzle-card-meta").textContent = getLang() === "en"
    ? `${ip.piecesPlaced}/${ip.piecesTotal} pieces assembled`
    : `${ip.piecesPlaced}/${ip.piecesTotal} деталей собрано`;
  $(card, ".btn.filled.sm").addEventListener("click", () => {
    navigate(`/table/${encodeURIComponent(ip.puzzleId)}`);
  }, { signal });
  $(card, ".progress-card-delete").addEventListener("click", async () => {
    const displayTitle = puzzleDisplayTitle(ip);
    const confirmMsg = getLang() === "en" ? `Delete build progress for "${displayTitle}"?` : `Удалить прогресс сборки «${displayTitle}»?`;
    if (!confirm(confirmMsg)) return;
    if (auth.isAuthenticated()) {
      try { await auth.fetch(`/api/puzzles/${encodeURIComponent(ip.puzzleId)}/progress`, { method: "DELETE" }); } catch { /* при следующей загрузке страницы просто снова покажется — не критично */ }
    } else {
      localStorage.removeItem(localKey(ip.puzzleId));
    }
    onDeleted();
  }, { signal });
  return card;
}

/** Рисует список незавершённых сборок в контейнер wrap (см. план
 *  «Продолжить сборку») — сетка карточек .puzzle-grid (та же, что у самой
 *  библиотеки) вместо текстовых строк, с пагинацией (см. план) — тот же
 *  паттерн .pager/PAGER_HTML, что у пагинации библиотеки и у комнат
 *  (ROOMS_PAGE_SIZE), просто с шагом 5. Пагинатор появляется, только если
 *  сборок больше одной страницы. Ничего не рисует, если список пуст. */
function renderInProgressList(wrap, items, signal) {
  if (!items.length) return;
  wrap.innerHTML = `<h3 class="room-section-title">${t("Продолжить сборку")}</h3><div class="puzzle-grid" id="inProgressGrid"></div>${PAGER_HTML()}`;
  const gridEl = $(wrap, "#inProgressGrid");
  const pagerEl = $(wrap, ".pager");
  const prevBtn = $(pagerEl, ".pager-prev");
  const nextBtn = $(pagerEl, ".pager-next");
  const label = $(pagerEl, ".pager-label");
  let page = 0;

  function renderPage() {
    const pages = Math.max(1, Math.ceil(items.length / IN_PROGRESS_PAGE_SIZE));
    page = Math.min(page, pages - 1);
    const start = page * IN_PROGRESS_PAGE_SIZE;

    gridEl.innerHTML = "";
    for (const ip of items.slice(start, start + IN_PROGRESS_PAGE_SIZE)) {
      gridEl.appendChild(buildInProgressCard(ip, signal, () => {
        items.splice(items.indexOf(ip), 1);
        if (!items.length) { wrap.innerHTML = ""; return; }
        renderPage();
      }));
    }

    const showPager = items.length > IN_PROGRESS_PAGE_SIZE;
    pagerEl.hidden = !showPager;
    if (showPager) {
      label.textContent = pagerLabel(page + 1, pages);
      prevBtn.disabled = page <= 0;
      nextBtn.disabled = page >= pages - 1;
    }
  }
  prevBtn.addEventListener("click", () => { page = Math.max(0, page - 1); renderPage(); }, { signal });
  nextBtn.addEventListener("click", () => { page += 1; renderPage(); }, { signal });
  renderPage();
}

/* ───────────────────────── шапка: аккаунт ─────────────────────────
 * Модалка #accountModalBackdrop — единая точка входа что для гостя, что
 * для вошедшего (см. правку «Тема и обучение — в окно "Аккаунт"»): значок
 * в шапке (#accountBtn) теперь всегда один и тот же, сама модалка
 * переключает #accountModalGuest/#accountModalUser. Раньше гость видел
 * отдельную текстовую «Войти» вместо значка — то же действие теперь внутри
 * модалки, одной кнопкой меньше в шапке. */
function renderAuthArea() {
  const authed = auth.isAuthenticated();
  const user = authed ? auth.getUser() : null;
  const label = (user && (user.name || user.username)) || t("аккаунт");
  const btn = document.getElementById("accountBtn");
  btn.title = authed ? `${t("Аккаунт")} — ${label}` : t("Аккаунт");
  btn.setAttribute("aria-label", btn.title);
}
document.getElementById("accountModalLoginBtn").addEventListener("click", () => {
  closeModal("accountModalBackdrop");
  auth.login();
});
// Тема/обучение — доступны и гостю, и вошедшему одинаково (см. index.html,
// #accountModalThemeBtn/#accountModalTourBtn вне #accountModalGuest/#accountModalUser).
document.getElementById("accountModalThemeBtn").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});
document.getElementById("accountModalTourBtn").addEventListener("click", () => {
  closeModal("accountModalBackdrop");
  openTour("library");
});
document.getElementById("accountBtn").addEventListener("click", () => {
  const authed = auth.isAuthenticated();
  document.getElementById("accountModalGuest").hidden = authed;
  document.getElementById("accountModalUser").hidden = !authed;
  if (authed) {
    const user = auth.getUser();
    document.getElementById("accountModalName").textContent = (user && (user.name || user.username)) || t("аккаунт");
    document.getElementById("accountModalMeta").textContent = (user && user.email) || "";
    loadAccountNotifications(); // асинхронно, не блокирует открытие модалки
  }
  openModal("accountModalBackdrop");
});
bindModal("accountModalBackdrop", null, "accountModalClose");

/** Системные уведомления Auth (см. план «Системные уведомления Auth →
 *  Puzzle») — только приём и отображение, без бейджа/поллинга/колокольчика:
 *  тех тут пока сознательно нет (первый сервис семьи, который вообще
 *  показывает этот канал). Показываем ТОЛЬКО свой префикс (type начинается
 *  на "puzzle.") — уведомления других сервисов эта вкладка не трогает и не
 *  помечает прочитанными, у каждого сервиса своя срезка одного общего
 *  списка (см. Auth/INTEGRATION.md, соглашение о префиксах). */
async function loadAccountNotifications() {
  const list = document.getElementById("accountNotificationsList");
  list.innerHTML = `<p class="state-note">${t("Загрузка…")}</p>`;
  let all;
  try {
    const res = await auth.fetch(`${auth.authBase}/api/notifications`);
    if (!res.ok) throw new Error("bad status");
    all = (await res.json()).notifications || [];
  } catch {
    list.innerHTML = `<p class="state-note">${t("Не удалось загрузить уведомления.")}</p>`;
    return;
  }
  const mine = all.filter(n => n.type.startsWith("puzzle."));
  if (!mine.length) {
    list.innerHTML = `<p class="state-note">${t("Нет уведомлений")}</p>`;
    return;
  }
  list.innerHTML = "";
  for (const n of mine) {
    const unread = !n.readAt;
    const item = document.createElement(n.url ? "a" : "div");
    item.className = "notification-item" + (unread ? " unread" : "");
    if (n.url) { item.href = n.url; item.target = "_blank"; item.rel = "noopener"; }
    const title = document.createElement("p");
    title.className = "notification-title";
    title.textContent = n.title;
    item.appendChild(title);
    if (n.body) {
      const body = document.createElement("p");
      body.className = "notification-body";
      body.textContent = n.body;
      item.appendChild(body);
    }
    if (unread) {
      item.addEventListener("click", () => {
        auth.fetch(`${auth.authBase}/api/notifications/${encodeURIComponent(n.id)}/read`, { method: "POST" }).catch(() => {});
      }, { once: true });
    }
    list.appendChild(item);
  }
}
document.getElementById("accountModalManage").addEventListener("click", () => {
  closeModal("accountModalBackdrop");
  window.open(auth.accountUrl(), "_blank", "noopener");
});
document.getElementById("accountModalLogout").addEventListener("click", () => {
  closeModal("accountModalBackdrop");
  auth.logout();
});

/* ───────────────────────── меню «…» карточки ─────────────────────────
 * Реверанс — тот же паттерн, что в Movies (renderCardMenu/.menu-wrap/.menu/
 * .menu-item, один открытый список на раз, закрытие по клику вовне): все
 * второстепенные действия карточки (Удалить/Скрыть, Опубликовать,
 * + В комнату) собраны в один выпадающий список вместо отдельных кнопок,
 * которые не влезали в узкую карточку. */
let openCardMenu = null; // { menu, btn } открытого меню, либо null
function closeCardMenu() {
  if (!openCardMenu) return;
  const { menu, btn } = openCardMenu;
  menu.hidden = true;
  btn.setAttribute("aria-expanded", "false");
  openCardMenu = null;
}
document.addEventListener("click", e => {
  if (!openCardMenu) return;
  const { menu, btn } = openCardMenu;
  if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeCardMenu();
});

/** items — [{label, danger, onClick(menuEl)}]. onClick получает сам DOM-узел
 *  .menu — нужно пункту «+ В комнату», который подменяет содержимое меню
 *  списком комнат вместо того, чтобы сразу закрыться (тот же приём, что
 *  renderAddToMenu в Movies). Остальные пункты сами вызывают closeCardMenu(). */
function renderCardMenu(items) {
  const wrap = document.createElement("div");
  // .menu-wrap уже существует в этом файле (шапка, #accountMenuWrap) —
  // переиспользуем тот же класс, а не заводим новый, конкретное
  // позиционирование поверх карточки — контекстным правилом в CSS
  // (.puzzle-card > .menu-wrap), тем же приёмом, что у Movies
  // (.movie-tile-poster-wrap .menu-wrap).
  wrap.className = "menu-wrap";
  wrap.innerHTML = `
    <button class="icon-btn xs" type="button" title="${t("Действия")}" aria-label="${t("Действия")}" aria-haspopup="true" aria-expanded="false">
      <svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/></svg>
    </button>
    <div class="menu" hidden></div>`;
  wrap.addEventListener("click", ev => ev.stopPropagation());
  const btn = wrap.querySelector("button");
  const menu = wrap.querySelector(".menu");

  function renderItems() {
    menu.innerHTML = "";
    for (const item of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "menu-item" + (item.danger ? " danger" : "");
      b.textContent = item.label;
      b.addEventListener("click", () => item.onClick(menu));
      menu.appendChild(b);
    }
  }
  renderItems();

  btn.addEventListener("click", ev => {
    ev.stopPropagation();
    const reopening = openCardMenu && openCardMenu.menu === menu;
    closeCardMenu();
    if (reopening) return;
    renderItems(); // сброс, если предыдущее открытие подменило содержимое (список комнат)
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    openCardMenu = { menu, btn };
  });
  return wrap;
}

/* ───────────────────────── библиотека ───────────────────────── */
function buildCard(p, opts = {}) {
  const tpl = document.getElementById("tplPuzzleCard");
  const node = tpl.content.firstElementChild.cloneNode(true);
  const img = $(node, "img");
  img.src = p.imageUrl;
  img.alt = puzzleDisplayTitle(p);
  img.decoding = "async";
  // Ленивая загрузка — везде, КРОМЕ первой карточки сетки (opts.eager, см.
  // вызовы buildCard в paintGrid/renderProfile): она обычно и есть LCP
  // (Largest Contentful Paint, метрика скорости, важна и для Core Web
  // Vitals, и для позиций в поиске) — если бы она тоже грузилась лениво,
  // это ЗАМЕДЛИЛО бы LCP, а не ускорило страницу.
  if (!opts.eager) img.loading = "lazy";
  $(node, ".puzzle-card-title").textContent = puzzleDisplayTitle(p);
  // Кнопка «За стол» — статичный текст в самом <template> (index.html),
  // ей нужен t() тут: шаблон клонируется заново на каждую карточку, но
  // сам текст внутри него не подхватывает язык сам по себе.
  $(node, ".puzzle-card-play").textContent = t("За стол");
  const variants = p.variants || [p];
  // «N уровней сложности» убрано — у нас нет настройки доступных уровней,
  // их всегда PIECE_PRESETS.length (6) у любого пазла, показывать это на
  // каждой карточке было чисто шумом. Число деталей конкретного уровня
  // теперь видно в самой модалке выбора сложности (см. openDifficultyModal).
  const metaEl = $(node, ".puzzle-card-meta");
  metaEl.hidden = true;
  const body = $(node, ".puzzle-card-body");
  // Атрибуция (см. план «Категории many-to-many, автор карточки, профиль»)
  // — только у ОДОБРЕННЫХ публикаций: это элемент публичной библиотеки, не
  // черновика — на своём же приватном/ждущем модерации фото она была бы
  // преждевременной (то, что ещё не прошло модерацию, не должно выглядеть
  // как уже опубликованное). Встроенные/добавленные через Admin — без
  // uploaderUsername вовсе, туда эта ветка и так не попадает. Переживает
  // модерацию (см. server.js, uploader_* не трогаются approve/reject), в
  // отличие от ownerUserId, который approve обнуляет.
  if (p.uploaderUsername && p.moderationStatus === "approved") {
    const author = document.createElement("a");
    author.className = "puzzle-card-author";
    author.href = `/profile/${encodeURIComponent(p.uploaderUserId)}`;
    author.textContent = `${t("Добавил:")} ${p.uploaderUsername}`;
    body.insertBefore(author, metaEl.nextSibling);
  }
  const mine = p.ownerUserId && auth.isAuthenticated() && auth.getUser()?.id === p.ownerUserId;
  // Библиотечный пазл (ownerUserId===null) внутри комнаты (opts.roomId
  // задан только в renderRoom) — можно убрать из ЭТОЙ комнаты (снять
  // добавление, см. removePuzzleFromRoom), доступно любому участнику, не
  // только владельцу комнаты (это общая настройка комнаты, не личная вещь).
  // В соло-библиотеке (opts.roomId нет) библиотечные пазлы по-прежнему не
  // удаляются никак.
  const canRemoveFromRoom = !p.ownerUserId && opts.roomId && auth.isAuthenticated();

  // Статус модерации — текстовая строка, не пункт меню (только на своих
  // фото, см. план «Модерация загруженных фото»).
  if (mine && p.moderationStatus) {
    const status = document.createElement("p");
    status.className = "puzzle-card-moderation " + p.moderationStatus;
    status.textContent = p.moderationStatus === "pending" ? t("На модерации")
      : p.moderationStatus === "approved" ? t("Опубликовано")
      : `${t("Отклонено:")} ${p.moderationReason || t("без причины")}`;
    // Просто appendChild — «За стол» теперь в .puzzle-card-title-row, не
    // прямой child body (см. index.html, tplPuzzleCard), insertBefore
    // относительно него больше не имеет смысла как ориентир позиции.
    body.appendChild(status);
  }

  const playBtn = $(node, ".puzzle-card-play");
  const onPlay = opts.onPlay || ((v, asymmetric, rotate) => {
    navigate(`/table/${encodeURIComponent(v.id)}?shape=${asymmetric ? "asym" : "normal"}&rotate=${rotate ? "1" : "0"}`);
  });
  // Кнопка «За стол» прямо на карточке — теперь только ВНУТРИ комнаты
  // (opts.roomId, стартует сеанс сразу в ЭТОЙ комнате, быстрый путь без
  // страницы пазла тут по-прежнему нужен). Вне комнаты (библиотека/
  // категория/профиль) кнопку убрали совсем (см. план «Страница пазла
  // вместо превью-модалки») — «За стол» переехало на саму страницу пазла
  // (renderPuzzlePage), клик по карточке теперь сразу ведёт туда.
  if (opts.roomId) {
    playBtn.addEventListener("click", e => {
      e.stopPropagation(); // не даём всплыть до клика по card ниже — то же самое действие делать дважды незачем
      if (variants.length > 1) openDifficultyModal(puzzleDisplayTitle(p), variants, onPlay);
      else onPlay(variants[0]);
    });
  } else {
    playBtn.remove();
  }
  // Клик по самой карточке (не по кнопке в углу — та уже обработана и
  // остановлена выше внутри комнаты, не по меню «…» — см. проверку ниже).
  // Внутри комнаты — превью-модалка (openPuzzlePreviewModal, картинка
  // покрупнее, автор, рейтинг, тот же выбор сложности): там речь о старте
  // сеанса В ЭТОЙ комнате, полноценная навигация была бы хуже. Вне комнаты
  // — переход на публичную страницу пазла (/puzzle/:id, шарится/
  // индексируется отдельно от /table/:id, см. план «Публичная ссылка на
  // пазл» → «Страница пазла вместо превью-модалки»).
  // Клавиатура + role=button/tabIndex — тем же приёмом, что .movie-tile в
  // Movies (см. renderMovieTile): карточка не <button> (внутри уже есть
  // свои button/a — меню «…», автор, в комнате ещё и «За стол»), поэтому
  // доступность через div[role=button][tabindex=0] + свой keydown на
  // Enter/Space, а не через родной элемент. closest("button")/
  // closest(".puzzle-card-author") — тот же фильтр, что и у click ниже:
  // keydown с фокусed вложенной кнопки/ссылки тоже всплывает сюда, открытие
  // не должно случаться поверх их действия.
  const isCardPreviewTarget = e => !e.target.closest("button") && !e.target.closest(".puzzle-card-author");
  const openCard = () => {
    if (opts.roomId) openPuzzlePreviewModal(p, { variants, onPlay });
    else navigate(`/puzzle/${encodeURIComponent(variants[0].id)}`);
  };
  node.setAttribute("role", "button");
  node.tabIndex = 0;
  node.addEventListener("click", e => { if (isCardPreviewTarget(e)) openCard(); });
  node.addEventListener("keydown", e => {
    if (!isCardPreviewTarget(e)) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openCard(); }
  });

  // Второстепенные действия — одно меню «…» (см. renderCardMenu выше,
  // реверанс Movies) вместо отдельных кнопок, которые не влезали в узкую
  // карточку (см. правку). Пункты собираются условно — если ни один не
  // подошёл, меню на карточке просто не появляется.
  const items = [];
  if (mine && opts.allowDelete !== false) {
    items.push({ label: t("Удалить"), danger: true, onClick: async () => {
      closeCardMenu();
      if (!confirm(`${t("Удалить пазл")} «${p.title}»?`)) return;
      try { await deletePuzzle(p.id); node.remove(); }
      catch (err) { alert(err.message === "in use" ? t("Этим пазлом уже играли в комнате — удалить нельзя.") : t("Не удалось удалить.")); }
    } });
  } else if (canRemoveFromRoom && opts.allowDelete !== false) {
    items.push({ label: t("Убрать из этой комнаты"), onClick: async () => {
      closeCardMenu();
      if (!confirm(`${t("Убрать пазл")} «${puzzleDisplayTitle(p)}» ${t("из этой комнаты? Он останется доступен во всех остальных комнатах и в общей библиотеке — можно будет добавить снова.")}`)) return;
      try { await removePuzzleFromRoom(opts.roomId, variants); node.remove(); }
      catch { alert(t("Не удалось убрать.")); }
    } });
  }
  if (mine && (!p.moderationStatus || p.moderationStatus === "rejected")) {
    items.push({ label: p.moderationStatus === "rejected" ? t("Отправить снова") : t("Опубликовать"), onClick: () => {
      closeCardMenu();
      openPublishModal(p.id, p.title, () => {
        p.moderationStatus = "pending"; p.moderationReason = null;
        const fresh = buildCard(p, opts);
        node.replaceWith(fresh);
      });
    } });
  }
  // «+ В комнату» — только в библиотеке/профиле (opts.roomId не задан):
  // внутри самой комнаты (renderRoom) у пазла уже есть прямое «За стол» в
  // ЭТУ комнату, второй выбор комнаты там был бы лишним (см. план).
  if (!opts.roomId) {
    async function addToRoom(roomId, variant, asymmetric, rotate) {
      try {
        const sessionId = await startRoomSession(roomId, variant.id, asymmetric, rotate);
        navigate(`/room/${encodeURIComponent(roomId)}/table/${encodeURIComponent(sessionId)}`);
      } catch (e) {
        alert(e.message === "room session limit reached"
          ? (getLang() === "en"
            ? `Reached the limit of simultaneous builds in this room${typeof e.limit === "number" ? ` (${e.limit})` : ""}.`
            : `Достигнут лимит одновременных сборок в этой комнате${typeof e.limit === "number" ? ` (${e.limit})` : ""}.`)
          : t("Не удалось начать сборку."));
      }
    }
    function pickVariantThenAdd(roomId) {
      if (variants.length > 1) openDifficultyModal(puzzleDisplayTitle(p), variants, (v, asymmetric, rotate) => addToRoom(roomId, v, asymmetric, rotate));
      else addToRoom(roomId, variants[0]);
    }
    items.push({ label: t("+ В комнату"), onClick: async menuEl => {
      // Подменяем содержимое меню списком комнат вместо того, чтобы сразу
      // закрыться (тот же приём, что renderAddToMenu в Movies) — второй
      // клик уже выбирает конкретную комнату.
      menuEl.innerHTML = `<p class="state-note" style="padding:.5em .8em">${t("Загрузка…")}</p>`;
      let rooms;
      try { rooms = await getRooms(); }
      catch { menuEl.innerHTML = `<p class="state-note" style="padding:.5em .8em">${t("Не удалось загрузить комнаты.")}</p>`; return; }
      if (!openCardMenu || openCardMenu.menu !== menuEl) return; // закрыли, пока грузили
      if (!rooms.length) {
        menuEl.innerHTML = `<p class="state-note" style="padding:.5em .8em">${t("У вас пока нет комнат.")}</p>`;
        const link = document.createElement("a");
        link.className = "menu-item";
        link.href = "/rooms";
        link.textContent = t("Перейти к комнатам");
        menuEl.appendChild(link);
        return;
      }
      menuEl.innerHTML = "";
      for (const room of rooms) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "menu-item";
        item.textContent = room.title;
        item.addEventListener("click", () => { closeCardMenu(); pickVariantThenAdd(room.id); });
        menuEl.appendChild(item);
      }
    } });
  }
  if (items.length) node.appendChild(renderCardMenu(items));
  return node;
}

async function applyBadge(node, p) {
  const progress = await progressFor(p).catch(() => null);
  const badge = $(node, ".puzzle-card-badge");
  if (!progress || !progress.pieces) { badge.hidden = true; return; }
  const total = progress.piecesTotal || p.gridRows * p.gridCols;
  const placed = progress.piecesPlaced || 0;
  if (progress.completedAt) {
    badge.textContent = t("Готово"); badge.classList.add("done"); badge.hidden = false;
    return;
  }
  if (placed > 0) {
    badge.textContent = `${Math.round((placed / total) * 100)}%`;
    badge.hidden = false;
    return;
  }
  badge.hidden = true;
}

const PUZZLE_PAGE_SIZE = 48;
// Функция, не константа-строка: должна перечитывать t() при каждом вызове
// (переключение языка перерисовывает текущий маршрут, см. setLang, но
// заранее вычисленная строка застряла бы в языке момента первой загрузки
// скрипта, а не подхватывала бы актуальный).
function PAGER_HTML() {
  return `
  <div class="pager" hidden>
    <button class="btn outlined sm pager-prev" type="button">← ${t("Назад")}</button>
    <span class="muted pager-label"></span>
    <button class="btn outlined sm pager-next" type="button">${t("Вперёд")} →</button>
  </div>`;
}

/** Общая пагинация сеток пазлов (библиотека/категория/профиль, см. план
 *  «Пагинация») — тот же паттерн, что ROOMS_PAGE_SIZE у комнат (см.
 *  renderRoomsList), просто с шагом 48 и карточками пазлов. gridEl/pagerEl
 *  — уже существующие в root контейнеры (см. PAGER_HTML выше). Возвращает
 *  show(items) — вызвать с полным списком карточек этой страницы;
 *  повторный вызов (смена фильтра категории и т.п.) сбрасывает на первую
 *  страницу пагинации. */
function mountPuzzleGridPager(gridEl, pagerEl, signal) {
  let items = [];
  let page = 0;
  const prevBtn = $(pagerEl, ".pager-prev");
  const nextBtn = $(pagerEl, ".pager-next");
  const label = $(pagerEl, ".pager-label");

  function renderPage() {
    const pages = Math.max(1, Math.ceil(items.length / PUZZLE_PAGE_SIZE));
    page = Math.min(page, pages - 1);
    const start = page * PUZZLE_PAGE_SIZE;
    const pageItems = items.slice(start, start + PUZZLE_PAGE_SIZE);

    gridEl.innerHTML = "";
    const cards = pageItems.map((p, i) => { const node = buildCard(p, { eager: page === 0 && i === 0 }); gridEl.appendChild(node); return { p, node }; });
    for (const { p, node } of cards) applyBadge(node, p);

    const showPager = items.length > PUZZLE_PAGE_SIZE;
    pagerEl.hidden = !showPager;
    if (showPager) {
      label.textContent = pagerLabel(page + 1, pages);
      prevBtn.disabled = page <= 0;
      nextBtn.disabled = page >= pages - 1;
    }
  }
  prevBtn.addEventListener("click", () => { page = Math.max(0, page - 1); renderPage(); gridEl.scrollIntoView({ block: "start" }); }, { signal });
  nextBtn.addEventListener("click", () => { page += 1; renderPage(); gridEl.scrollIntoView({ block: "start" }); }, { signal });

  return newItems => { items = newItems; page = 0; renderPage(); };
}

/** «Не нашли нужные пазлы?» — подвал библиотеки/категорий (см. план),
 *  ведёт в уже существующий POST /api/categories — пользовательскую
 *  заявку на новую категорию (см. server.js, api()): уходит в pending,
 *  дальше — обычная модерация в Admin («Модерация категорий»), та же
 *  очередь, что и у заявок из формы публикации своего фото. Ничего нового
 *  на бэкенде заводить не пришлось — этой кнопки просто не было у уже
 *  готового примитива. Гостю показываем «Войти», не саму форму — роут
 *  отбивает 401 без входа, тот же принцип, что у guest-note в
 *  renderLibrary (тут это отдельная функция, не общий блок с ней, потому
 *  что нужна на трёх разных страницах — библиотека, категории, страница
 *  категории — с разными местами вставки, но одинаковым содержимым). */
function renderCategorySuggestBox(signal) {
  const section = document.createElement("section");
  section.className = "category-suggest";
  // Иконка — лампочка (идея/предложение), тот же фирменный зелёный
  // градиент, что у акцентной полоски карточки комнаты (см. CSS,
  // .category-suggest-icon) — единственное яркое цветовое пятно на
  // подсказке, весь остальной текст — нейтральный. Всё центрировано одной
  // колонкой (см. CSS) — без обёртки .category-suggest-body: раньше текст
  // и форма жили в ней рядом с иконкой в строку, теперь все прямые дети
  // секции просто идут друг под другом.
  section.innerHTML = `
    <div class="category-suggest-icon">
      <svg class="icon" viewBox="0 0 24 24"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2.3v.5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-.5c0-1.1.4-1.8 1-2.3A7 7 0 0 0 12 2z"/></svg>
    </div>
    <h2>${t("Не нашли нужные пазлы?")}</h2>
    <p>${t("Предложите категорию, которой не хватает — рассмотрим и добавим.")}</p>`;

  if (!auth.isAuthenticated()) {
    const btn = document.createElement("button");
    btn.className = "btn tonal sm";
    btn.type = "button";
    btn.textContent = t("Войти, чтобы предложить категорию");
    btn.addEventListener("click", () => auth.login(), { signal });
    section.appendChild(btn);
    return section;
  }

  const form = document.createElement("form");
  form.className = "category-suggest-form";
  form.innerHTML = `
    <input class="text-input" type="text" maxlength="80" placeholder="${t("Например: Космос")}" required>
    <button class="btn filled sm" type="submit">${t("Предложить")}</button>`;
  const note = document.createElement("p");
  note.className = "state-note";
  note.hidden = true;
  section.append(form, note);

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const input = $(form, "input");
    const name = input.value.trim();
    if (!name) return;
    const btn = $(form, "button[type=submit]");
    btn.disabled = true;
    note.hidden = true;
    try {
      const res = await auth.fetch("/api/categories", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "failed");
      input.value = "";
      note.textContent = t("Спасибо! Категория отправлена на рассмотрение.");
    } catch {
      note.textContent = t("Не удалось отправить — попробуйте ещё раз.");
    }
    note.hidden = false;
    btn.disabled = false;
  }, { signal });

  return section;
}

async function renderLibrary(root, signal) {
  // Тот же текст, что в index.html — статичная заглушка ДО отработки JS
  // (см. план «SEO», комментарий там же) — расхождение тут читалось бы
  // краулером как подмена контента после рендера. FAQ теперь в футере
  // (см. план «Футер») — он вне #app и переживает смену маршрута без
  // участия JS, поэтому здесь больше не дублируется.
  root.innerHTML = `
    <div class="library-head">
      <h1>${t("Пазлы онлайн бесплатно — собрать пазл в браузере")}</h1>
      <p>${t("Собирайте пазлы онлайн бесплатно и без скачивания — готовые из библиотеки или свои из любой фотографии. Детали фигурные, стол зумится и двигается, можно собирать одному или вместе с друзьями в комнате. Вход нужен только для того, чтобы прогресс сохранялся между заходами.")}</p>
    </div>
    <div id="guestNoteWrap"></div>
    <div id="inProgressWrap"></div>
    <div id="categoryCarouselWrap"></div>
    <div class="puzzle-grid" id="puzzleGrid"><p class="state-note">${t("Загружаем…")}</p></div>
    ${PAGER_HTML()}`;

  if (!auth.isAuthenticated()) {
    const note = document.createElement("div");
    note.className = "guest-note";
    const span = document.createElement("span");
    span.textContent = t("Играть можно без входа — прогресс тогда хранится только в этом браузере.");
    const btn = document.createElement("button");
    btn.className = "btn tonal sm"; btn.type = "button";
    btn.textContent = t("Войти и сохранять прогресс");
    btn.addEventListener("click", () => auth.login());
    note.append(span, btn);
    $(root, "#guestNoteWrap").appendChild(note);
  }

  let puzzles, categories;
  try {
    [puzzles, categories] = await Promise.all([getPuzzles(), getCategories().catch(() => []), ensureDisplayTitleCache()]);
  } catch {
    if (!signal.aborted) $(root, "#puzzleGrid").innerHTML = `<p class="state-note">${t("Не удалось загрузить пазлы — обновите страницу.")}</p>`;
    return;
  }
  if (signal.aborted) return;

  // «Продолжить сборку» — над библиотекой (см. план), не блокирует
  // остальной рендер: список загружается параллельно, появляется, когда
  // готов, а не задерживает сетку/карусель.
  inProgressPuzzles(puzzles).then(items => {
    if (!signal.aborted) renderInProgressList($(root, "#inProgressWrap"), items, signal);
  });

  // Свои фото — только в комнатах (см. README «Свои фото»), соло-библиотека
  // видит исключительно встроенные пазлы. groupPuzzles сводит все уровни
  // сложности одного изображения (общий imageUrl) в одну карточку — иначе
  // Холмы/Лес/Горы показались бы по 6 раз каждый (см. server.js, BUILTIN_IMAGES).
  const allGroups = groupPuzzles(puzzles.filter(p => !p.ownerUserId));
  // Перемешиваем порядок один раз за загрузку страницы (не кнопка, не при
  // каждом ре-рендере/переключении категории — showPage(allGroups) ниже и
  // клик по чипу «Все» переиспользуют этот же уже перемешанный массив, а не
  // трогают shuffleInPlace повторно) — иначе библиотека каждый раз выглядит
  // одинаково в исходном порядке БД, а с одной колодой пазлов интереснее
  // открывать что-то новое сверху. Фильтр по категории (filterGroupsByCategory)
  // сохраняет относительный порядок элементов — категории тоже наследуют
  // это перемешивание, отдельно их не переупорядочиваем.
  shuffleInPlace(allGroups);
  const showPage = mountPuzzleGridPager($(root, "#puzzleGrid"), $(root, ".pager"), signal);

  // Одна категория на пазл (см. план «Один пазл — одна категория») —
  // каждый пазл считается ровно в одном счётчике, некатегоризированные
  // (categoryId нет) не считаются нигде.
  const counts = new Map();
  for (const p of allGroups) if (p.categoryId) counts.set(p.categoryId, (counts.get(p.categoryId) || 0) + 1);
  // Пустые категории (0 пазлов) не показываем вовсе (см. план) — чип-фильтр
  // на пустое множество только сбивал бы с толку. Карусель рисуем, только
  // если после этого хоть одна категория осталась — иначе единственный чип
  // «Все» без выбора был бы бессмысленным элементом (см. план «Категории
  // пазлов»).
  const nonEmptyCategories = categories.filter(c => (counts.get(c.id) || 0) > 0);
  if (nonEmptyCategories.length) {
    const carouselEl = $(root, "#categoryCarouselWrap");
    const chips = [{ id: null, name: t("Все"), count: allGroups.length }, ...nonEmptyCategories.map(c => ({ id: c.id, name: categoryDisplayName(c), count: counts.get(c.id) }))];
    const carousel = document.createElement("div");
    carousel.className = "category-carousel";
    for (const c of chips) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "category-chip" + (c.id === null ? " is-active" : "");
      btn.textContent = `${c.name} (${c.count})`;
      btn.dataset.id = c.id || "";
      btn.addEventListener("click", () => {
        carousel.querySelectorAll(".category-chip").forEach(chip => chip.classList.remove("is-active"));
        btn.classList.add("is-active");
        showPage(c.id === null ? allGroups : filterGroupsByCategory(allGroups, c.id));
      });
      carousel.appendChild(btn);
    }
    carouselEl.appendChild(carousel);
    // На телефонах карусель сворачивается до 2 строк (см. план «Категории
    // на телефонах») — max-height/overflow:hidden только внутри мобильного
    // media-запроса в styles.css, тут просто решаем, нужна ли вообще кнопка
    // «Показать ещё»: carousel.scrollHeight — ПОЛНАЯ высота содержимого,
    // не зависит от того, обрезано оно сейчас overflow:hidden или уже
    // развёрнуто (.expanded), поэтому порог сравниваем с ТЕМ ЖЕ числом,
    // что задаёт CSS (6.4rem), а не с текущим clientHeight — тот врал бы
    // после первого разворачивания.
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "category-carousel-toggle";
    toggle.textContent = t("Показать ещё категории");
    toggle.addEventListener("click", () => {
      const expanded = carousel.classList.toggle("expanded");
      toggle.textContent = expanded ? t("Свернуть категории") : t("Показать ещё категории");
    });
    carouselEl.appendChild(toggle);
    const updateToggleVisibility = () => {
      const twoRowsPx = 6.4 * parseFloat(getComputedStyle(document.documentElement).fontSize);
      const overflowing = window.matchMedia("(max-width: 30rem)").matches && carousel.scrollHeight > twoRowsPx + 4;
      toggle.classList.toggle("is-visible", overflowing);
      if (!overflowing) { carousel.classList.remove("expanded"); toggle.textContent = t("Показать ещё категории"); }
    };
    updateToggleVisibility();
    window.addEventListener("resize", updateToggleVisibility, { signal });
  }

  showPage(allGroups);
  root.appendChild(renderCategorySuggestBox(signal));
}

/** Профиль пользователя (см. план «Категории many-to-many, автор карточки,
 *  профиль») — все ОДОБРЕННЫЕ публикации конкретного человека, публично,
 *  без входа (та же логика открытости, что и у самой библиотеки). Куда
 *  проще renderLibrary — нет карусели категорий, нет своих фото. */
async function renderProfile(root, userId, signal) {
  root.innerHTML = `
    <div class="library-head" id="profileHead"><h1>${t("Загружаем…")}</h1></div>
    <div class="puzzle-grid" id="puzzleGrid"><p class="state-note">${t("Загружаем…")}</p></div>
    ${PAGER_HTML()}`;

  let data;
  try {
    const res = await fetch(`/api/users/${encodeURIComponent(userId)}/puzzles`);
    if (!res.ok) throw new Error("profile fetch failed");
    data = await res.json();
  } catch {
    if (!signal.aborted) root.innerHTML = `<p class="state-note">${t("Не удалось загрузить профиль — обновите страницу.")}</p>`;
    return;
  }
  if (signal.aborted) return;

  const headEl = $(root, "#profileHead");
  headEl.innerHTML = data.username
    ? `<h1>${t("Пазлы, опубликованные")} ${data.username}</h1>`
    : `<h1>${t("Профиль")}</h1><p>${t("Пользователь ничего не опубликовал.")}</p>`;

  if (!data.puzzles.length) {
    $(root, "#puzzleGrid").outerHTML = `<p class="state-note">${t("Пока ничего не опубликовано.")}</p>`;
    $(root, ".pager").remove();
    return;
  }
  const showPage = mountPuzzleGridPager($(root, "#puzzleGrid"), $(root, ".pager"), signal);
  showPage(groupPuzzles(data.puzzles));
}

/** Дефолтные title/description — дословно как в index.html и в
 *  DEFAULT_TITLE/DEFAULT_DESCRIPTION в server.js (см. serveApp) — нужны
 *  здесь, чтобы сбрасывать title/description при уходе с /categories или
 *  /category/:slug на любой другой маршрут (без сброса вкладка сохраняла
 *  бы чужой заголовок после клиентского перехода, скажем, в комнату). */
const DEFAULT_TITLE = "Пазлы онлайн бесплатно — собрать пазл в браузере | Что собираем?";
const DEFAULT_DESCRIPTION = "Собирайте пазлы онлайн бесплатно и без скачивания — готовые из библиотеки или свой из любой фотографии. Фигурные детали, зум и панорама стола, совместная сборка с друзьями в комнате в реальном времени.";

function setPageMeta(title, description) {
  document.title = title;
  const meta = document.querySelector('meta[name="description"]');
  if (meta) meta.setAttribute("content", description);
}

/** Страница со всеми категориями (см. план «Прямые ссылки + страница
 *  категорий») — блоки-карточки, клик по любой ведёт на /category/:slug
 *  (перехватывается делегированным обработчиком кликов ниже, без
 *  перезагрузки). Число пазлов — те же публичные группы и тот же подсчёт,
 *  что у карусели на главной (renderLibrary): API отдаёт только
 *  {id, name, slug}, подсчёт всегда на клиенте. */
const CATEGORIES_TITLE = "Категории пазлов онлайн — собрать пазл по теме | Что собираем?";
const CATEGORIES_DESCRIPTION = "Все категории пазлов онлайн в одном месте — выберите тему и собирайте бесплатно, без регистрации и скачивания.";

async function renderCategories(root, signal) {
  root.innerHTML = `
    <div class="library-head">
      <h1>${t("Категории пазлов онлайн")}</h1>
      <p>${t("Выберите категорию — соберите пазл по теме, бесплатно и без регистрации.")}</p>
    </div>
    <div class="category-block-grid" id="categoryBlockGrid"><p class="state-note">${t("Загружаем…")}</p></div>`;

  let categories, puzzles;
  try {
    [categories, puzzles] = await Promise.all([getCategories(), getPuzzles()]);
  } catch {
    if (!signal.aborted) $(root, "#categoryBlockGrid").innerHTML = `<p class="state-note">${t("Не удалось загрузить категории — обновите страницу.")}</p>`;
    return;
  }
  if (signal.aborted) return;

  setPageMeta(CATEGORIES_TITLE, CATEGORIES_DESCRIPTION);

  const allGroups = groupPuzzles(puzzles.filter(p => !p.ownerUserId));
  const counts = new Map();
  for (const p of allGroups) if (p.categoryId) counts.set(p.categoryId, (counts.get(p.categoryId) || 0) + 1);

  // Пустые категории (0 пазлов) не показываем — вести на страницу без
  // единой карточки незачем (см. план).
  const nonEmptyCategories = categories.filter(c => (counts.get(c.id) || 0) > 0);

  const gridEl = $(root, "#categoryBlockGrid");
  if (!nonEmptyCategories.length) {
    gridEl.innerHTML = `<p class="state-note">${t("Категорий пока нет.")}</p>`;
    root.appendChild(renderCategorySuggestBox(signal));
    return;
  }
  gridEl.innerHTML = "";
  for (const c of nonEmptyCategories) {
    const count = counts.get(c.id);
    // Обложка — первый пазл категории (см. план «Обложка категории»), тот
    // же порядок, что и allGroups: с сервера уже ORDER BY sort_order,
    // created_at (см. server.js, stmt.puzzlesPublic), groupPuzzles его не
    // меняет — так что group[0] тут и есть «первый» в том же смысле,
    // что и в остальной библиотеке.
    const cover = filterGroupsByCategory(allGroups, c.id)[0];
    const a = document.createElement("a");
    a.className = "category-block";
    a.href = `/category/${encodeURIComponent(c.slug)}`;
    const thumb = document.createElement("div");
    thumb.className = "category-block-thumb";
    const img = document.createElement("img");
    img.src = cover.imageUrl;
    // Название категории, не пусто — та же правка, что и у серверного
    // categoriesListHtml (см. server.js): картиночный поиск может завести
    // сюда, alt тогда должен что-то говорить сам по себе.
    img.alt = categoryDisplayName(c);
    img.loading = "lazy";
    thumb.appendChild(img);
    const body = document.createElement("div");
    body.className = "category-block-body";
    const name = document.createElement("span");
    name.className = "category-block-name";
    name.textContent = categoryDisplayName(c);
    const countEl = document.createElement("span");
    countEl.className = "category-block-count";
    countEl.textContent = `${count} ${tn(count, ["пазл", "пазла", "пазлов"], ["puzzle", "puzzles"])}`;
    body.append(name, countEl);
    a.append(thumb, body);
    gridEl.appendChild(a);
  }
  root.appendChild(renderCategorySuggestBox(signal));
}

/** Страница одной категории (см. план «Прямые ссылки + страница
 *  категорий») — категория ищется по slug на клиенте, отдельного
 *  GET /api/categories/:slug нет (список категорий и так публичный и
 *  короткий). Сетка — та же фильтрация, что в карусели renderLibrary,
 *  через общий filterGroupsByCategory. */
async function renderCategoryPage(root, slug, signal) {
  root.innerHTML = `
    <div class="library-head" id="categoryHead"><h1>${t("Загружаем…")}</h1></div>
    <div class="puzzle-grid" id="puzzleGrid"><p class="state-note">${t("Загружаем…")}</p></div>
    ${PAGER_HTML()}`;

  let categories, puzzles;
  try {
    [categories, puzzles] = await Promise.all([getCategories(), getPuzzles(), ensureDisplayTitleCache()]);
  } catch {
    if (!signal.aborted) root.innerHTML = `<p class="state-note">${t("Не удалось загрузить категорию — обновите страницу.")}</p>`;
    return;
  }
  if (signal.aborted) return;

  const category = categories.find(c => c.slug === slug);
  const headEl = $(root, "#categoryHead");

  if (!category) {
    setPageMeta(DEFAULT_TITLE, DEFAULT_DESCRIPTION);
    headEl.innerHTML = "";
    const h1 = document.createElement("h1");
    h1.textContent = t("Категория не найдена");
    const p = document.createElement("p");
    p.textContent = t("Такой категории нет — возможно, её переименовали или удалили. ");
    const link = document.createElement("a");
    link.href = "/categories";
    link.textContent = t("Все категории");
    p.appendChild(link);
    headEl.append(h1, p);
    $(root, "#puzzleGrid").remove();
    $(root, ".pager").remove();
    root.appendChild(renderCategorySuggestBox(signal));
    return;
  }

  const allGroups = groupPuzzles(puzzles.filter(p => !p.ownerUserId));
  const groups = filterGroupsByCategory(allGroups, category.id);

  // SEO title/description — только русские, сайт русскоязычный (см. план
  // «Английский язык в интерфейсе», не переключаются вместе с интерфейсом).
  setPageMeta(
    `Пазлы: ${category.name} — собрать онлайн бесплатно | Что собираем?`,
    `Пазлы онлайн в категории «${category.name}» — собирайте бесплатно, без регистрации и скачивания.`,
  );

  const displayName = categoryDisplayName(category);
  headEl.innerHTML = "";
  const h1 = document.createElement("h1");
  h1.textContent = `${t("Пазлы:")} ${displayName}`;
  const intro = document.createElement("p");
  intro.textContent = getLang() === "en"
    ? `${groups.length} ${groups.length === 1 ? "puzzle" : "puzzles"} in the "${displayName}" category — solve them online for free.`
    : `${groups.length} ${plural(groups.length, "пазл", "пазла", "пазлов")} в категории «${displayName}» — собирайте онлайн бесплатно.`;
  headEl.append(h1, intro);

  if (!groups.length) {
    const grid = $(root, "#puzzleGrid");
    grid.innerHTML = "";
    const note = document.createElement("p");
    note.className = "state-note";
    note.textContent = t("В этой категории пока нет пазлов. ");
    const link = document.createElement("a");
    link.href = "/categories";
    link.textContent = t("Все категории");
    note.appendChild(link);
    grid.appendChild(note);
    $(root, ".pager").remove();
    root.appendChild(renderCategorySuggestBox(signal));
    return;
  }
  const showPage = mountPuzzleGridPager($(root, "#puzzleGrid"), $(root, ".pager"), signal);
  showPage(groups);
  root.appendChild(renderCategorySuggestBox(signal));
}

/* ───────────────────────── стол: раскладка деталей ───────────────────────── */

/**
 * Начальная случайная раскладка вокруг контура доски: сетка ячеек размером
 * с деталь, исключая область самой доски, с лёгким дрожанием (jitter), чтобы
 * детали не стояли идеально ровным строем. Область (margin) при нехватке
 * места под все детали расширяется — так это работает и для 12 деталей, и
 * для 108 без ручной подгонки под каждый пазл.
 *
 * count — сколько ячеек реально нужно (по умолчанию rows*cols, как при
 * начальной раскладке всех деталей). planShuffle передаёт сюда РЕАЛЬНОЕ
 * число одиночных деталей, а не rows*cols — margin растёт, только пока не
 * наберётся нужное количество ячеек именно под них, поэтому при решаффле
 * (когда большая часть уже состыкована и трогать её не нужно) россыпь
 * получается заметно теснее к рамке доски, а не растянутой на весь запас
 * под полный пазл.
 *
 * origin — где РЕАЛЬНО стоит доска в мировых координатах ({x,y}, обычно
 * BOARD_X/BOARD_Y из renderTable/renderRoomTable). Без него (начальная
 * раскладка) доска считается стоящей в (margin,margin) — так было и раньше,
 * margin растёт вместе с "миром", который тогда ещё не существует. С явным
 * origin (решафл: доска давно стоит на месте, мир уже фиксированного
 * размера) сетка кандидатов строится ТЕСНЫМ кольцом вокруг РЕАЛЬНОЙ позиции
 * доски, а не от нуля мировых координат — без этого при меньшем margin
 * (см. выше) кольцо кандидатов оставалось привязано к margin=0 в углу
 * мира, а не к настоящей доске, и россыпь после решафла оказывалась не
 * вокруг доски, а смещённой к краю мира (баг: "решафл собирает левее
 * рамки").
 */
function scatterLayout(rows, cols, cell, pad, count = rows * cols, origin = null) {
  const pieceSize = cell + 2 * pad;
  const boardW = cols * cell, boardH = rows * cell;
  const total = count;
  let margin = pieceSize * 1.4;
  let cells = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const step = pieceSize * 1.08;
    const originX = origin ? origin.x : margin, originY = origin ? origin.y : margin;
    const bx0 = originX - pad * 0.3, bx1 = originX + boardW + pad * 0.3;
    const by0 = originY - pad * 0.3, by1 = originY + boardH + pad * 0.3;
    const gx0 = origin ? Math.max(0, Math.floor((originX - margin) / step)) : 0;
    const gy0 = origin ? Math.max(0, Math.floor((originY - margin) / step)) : 0;
    const gx1 = origin ? Math.ceil((originX + boardW + margin) / step) : Math.max(1, Math.floor((boardW + 2 * margin) / step));
    const gy1 = origin ? Math.ceil((originY + boardH + margin) / step) : Math.max(1, Math.floor((boardH + 2 * margin) / step));
    cells = [];
    for (let gy = gy0; gy < gy1; gy++) {
      for (let gx = gx0; gx < gx1; gx++) {
        const cx = gx * step + step / 2, cy = gy * step + step / 2;
        if (cx > bx0 && cx < bx1 && cy > by0 && cy < by1) continue; // область доски — не рассыпаем сюда
        cells.push({ x: gx * step, y: gy * step });
      }
    }
    if (cells.length >= total) break;
    margin *= 1.35;
  }
  shuffleInPlace(cells);
  const jitter = pieceSize * 0.1;
  const picked = cells.slice(0, total).map(p => ({
    x: p.x + (Math.random() * 2 - 1) * jitter,
    y: p.y + (Math.random() * 2 - 1) * jitter,
  }));
  const originX = origin ? origin.x : margin, originY = origin ? origin.y : margin;
  return { margin, worldW: originX + boardW + margin, worldH: originY + boardH + margin, cells: picked };
}
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/* ───────────────────────── стол: кластеры (связи вместо фиксированного места) ─────────────────────────
 * Кластер нигде не хранится явно — выводится заново из raw {r,c,x,y} через
 * assets/puzzle-clusters.js (общий модуль с сервером) на каждое значимое
 * событие. Счётчик "собрано" = сумма деталей во ВСЕХ кластерах от двух и
 * больше (connectedPiecesCount) — деталь, состыкованная хоть с кем-то,
 * засчитывается сразу, не только когда её кусок дорастёт до самого
 * большого сегмента. "Пазл решён целиком" — отдельная, более строгая
 * проверка (largestClusterSize === total, см. isPuzzleSolved ниже), не
 * путать с этим счётчиком. */

/** Счётчик "собрано" для интерфейса — заменяет старое
 *  [...pieces.values()].filter(p=>p.placed).length. */
function computePiecesPlaced(pieces, cell, tol) {
  return window.PuzzleClusters.connectedPiecesCount(window.PuzzleClusters.buildClusters(pieces.values(), cell, tol).members);
}

/** "Пазл целиком собран" — ВСЕ детали в одном кластере, а не просто у
 *  каждой есть сосед где-то на борде (это отдельно, см. computePiecesPlaced
 *  выше). Используется там, где решается "показать ли победу". */
function isPuzzleSolved(pieces, cell, tol, total) {
  return window.PuzzleClusters.largestClusterSize(window.PuzzleClusters.buildClusters(pieces.values(), cell, tol).members) >= total;
}

function edgeId(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
function clusterEdgeIds(edges) {
  const set = new Set();
  for (const [a, b] of edges) set.add(edgeId(a, b));
  return set;
}
/** Вспышка "just-snapped" на КАЖДОЕ новое ребро кластерного графа — сравнение
 *  с набором id рёбер от прошлого пересчёта (prevIds), не поштучная проверка
 *  расстояния до target (target у детали больше нет). Возвращает новый набор
 *  id (для следующего сравнения) и число добавившихся рёбер — по нему
 *  bindRoomPieceDrag решает, слать move или group (см. план). */
function flashClusterEdges(pieces, prevIds, edges) {
  const nextIds = clusterEdgeIds(edges);
  let newCount = 0;
  for (const [a, b] of edges) {
    const id = edgeId(a, b);
    if (prevIds.has(id)) continue;
    newCount++;
    for (const k of [a, b]) {
      const p = pieces.get(k);
      if (!p || !p.el) continue;
      p.el.classList.add("just-snapped");
      setTimeout(() => p.el.classList.remove("just-snapped"), 600);
    }
  }
  return { nextIds, newCount };
}

/** Ключи всей связанной группы, в которую входит key (см. buildClusters) —
 *  клик по одной детали выделяет весь уже собранный сегмент целиком, а не
 *  только саму деталь: тащить всё равно будет весь кластер (см. groupSet в
 *  pointerdown), выделение теперь просто отражает это заранее, а не только
 *  во время самого драга. */
function clusterMembersOf(pieces, key) {
  const { clusterOf, members } = window.PuzzleClusters.buildClusters(pieces.values(), CELL, SNAP_TOLERANCE);
  return members.get(clusterOf.get(key));
}

/** Подсказка (см. план «Повороты деталей + звук + подсказка») — случайная
 *  ещё НЕ состыкованная пара соседних по сетке (r,c) деталей: перебираем
 *  каждое ребро сетки (вправо/вниз, тем же приёмом, что buildClusters) и
 *  оставляем те, чьи концы сейчас в РАЗНЫХ кластерах. Ничего не двигает и
 *  не стыкует — вызывающий код (renderTable/renderRoomTable) сам решает,
 *  как это подсветить и подвести туда камеру. null, если пазл уже собран
 *  целиком (подсказывать нечего). */
function pickHintPair(pieces) {
  const { clusterOf } = window.PuzzleClusters.buildClusters(pieces.values(), CELL, SNAP_TOLERANCE);
  const candidates = [];
  for (const p of pieces.values()) {
    for (const [dr, dc] of [[0, 1], [1, 0]]) {
      const n = pieces.get(`${p.r + dr},${p.c + dc}`);
      if (!n) continue;
      if (clusterOf.get(`${p.r},${p.c}`) === clusterOf.get(`${n.r},${n.c}`)) continue;
      candidates.push([p, n]);
    }
  }
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** «Перемешать» с учётом кластеров: ЛЮБОЙ уже состыкованный кластер (от двух
 *  деталей — это уже прогресс, не только самый большой) не трогаем,
 *  расшвыриваем только одиночные, ещё ни с кем не соединённые детали.
 *  Раскладка под них считается по их реальному числу (scatterLayout(...,
 *  count)), не по rows*cols — россыпь ложится плотнее к рамке доски, а не
 *  на весь запас места под полный пазл. boardX/boardY — РЕАЛЬНАЯ позиция
 *  доски в мировых координатах (BOARD_X/BOARD_Y у вызывающего) — без неё
 *  scatterLayout считала бы, что доска стоит в (margin,margin) с НОВЫМ,
 *  обычно куда меньшим margin, чем настоящий — россыпь оказывалась смещена
 *  относительно реальной доски (баг «решафл собирает левее рамки»).
 *  Возвращает Map "r,c" -> {x,y} новых позиций или null, если мешать
 *  нечего (все детали уже хоть с кем-то состыкованы). */
function planShuffle(pieces, rows, cols, cell, pad, tol, boardX, boardY) {
  const { members } = window.PuzzleClusters.buildClusters(pieces.values(), cell, tol);
  const toScatter = [...members.values()].filter(keys => keys.size <= 1);
  if (!toScatter.length) return null;

  const fresh = scatterLayout(rows, cols, cell, pad, toScatter.length, { x: boardX, y: boardY });
  const next = new Map();
  toScatter.forEach((keys, i) => {
    const [key] = keys;
    const anchor = fresh.cells[Math.min(i, fresh.cells.length - 1)];
    next.set(key, { x: anchor.x, y: anchor.y });
  });
  return next;
}

/** Один <div class="piece"> со своим <svg viewBox="0 0 size size">, clipPath и <image>,
 *  все детали одного пазла ссылаются на один и тот же URL картинки. */
function createPieceEl(puzzleId, r, c, rows, cols, cell, pad, edges, imageUrl, boardW, boardH) {
  const size = cell + 2 * pad;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));

  const d = window.PuzzleShapes.buildPiecePath(r, c, rows, cols, cell, edges);
  const clipId = `clip-${puzzleId}-${r}-${c}`;

  const defs = document.createElementNS(NS, "defs");
  const clip = document.createElementNS(NS, "clipPath");
  clip.setAttribute("id", clipId);
  const clipPath = document.createElementNS(NS, "path");
  clipPath.setAttribute("d", d);
  clip.appendChild(clipPath);
  defs.appendChild(clip);
  svg.appendChild(defs);

  // Картинка — целиком, одна и та же на все детали (браузер декодирует раз),
  // сдвинута так, что у детали (r,c) в её локальных координатах видна ровно
  // её часть общей картинки; preserveAspectRatio="none" растягивает картинку
  // строго на boardW×boardH — без этого несовпадение пропорций дало бы поля,
  // одинаковые у всех деталей, но не бесшовные на стыках.
  const img = document.createElementNS(NS, "image");
  img.setAttributeNS("http://www.w3.org/1999/xlink", "href", imageUrl);
  img.setAttribute("href", imageUrl);
  img.setAttribute("x", String(-(c * cell - pad)));
  img.setAttribute("y", String(-(r * cell - pad)));
  img.setAttribute("width", String(boardW));
  img.setAttribute("height", String(boardH));
  img.setAttribute("preserveAspectRatio", "none");
  img.setAttribute("clip-path", `url(#${clipId})`);
  svg.appendChild(img);

  const wrap = document.createElement("div");
  wrap.className = "piece";
  wrap.style.width = size + "px";
  wrap.style.height = size + "px";
  wrap.dataset.r = String(r);
  wrap.dataset.c = String(c);
  wrap.appendChild(svg);
  // <image> внутри — по умолчанию нативно перетаскиваемый браузером элемент
  // (как обычная картинка): при достаточно долгом/дальнем драге (особенно
  // заметно у групп — жест длиннее) браузер может перехватить его в СВОЙ
  // HTML5 drag-and-drop поверх нашего pointer-based — курсор "нельзя"
  // означает именно это, а не что-то в bindPieceDrag. dragstart тут не
  // связан с Pointer Events вообще, глушим его отдельно.
  wrap.addEventListener("dragstart", e => e.preventDefault());
  return wrap;
}

function applyPieceTransform(piece) {
  // rotate — после translate, вокруг центра элемента (стандартный
  // transform-origin) — см. план «Повороты деталей»/puzzle-clusters.js
  // (buildClusters требует rot%360===0 для стыковки). ||0 — деталь без
  // включённого режима поворотов просто не несёт этого поля.
  piece.el.style.transform = `translate(${piece.x}px, ${piece.y}px) rotate(${piece.rot || 0}deg)`;
}

/** Превью-картинка «как должно получиться» на столе — раньше была чисто
 *  декоративной подсказкой (pointer-events:none, фиксированные место и
 *  размер в углу), теперь плавающая панель: можно оттащить с дороги и
 *  подрастянуть, если мелко видно детали. Общая для соло и комнаты — это
 *  чисто локальный UI, сети не касается (в отличие от bindPieceDrag/
 *  bindRoomPieceDrag, которые из-за этого разделены). Живёт прямо в
 *  .table-stage, а не в #world — панорама/зум доски (translate+scale на
 *  #world) на неё не действует, поэтому дельты драга/резайза берутся в
 *  чистых экранных пикселях, без деления на zoom. */
function bindPreviewThumb(stage, panel, img, handle, toggleBtn, imageUrl, title, signal) {
  img.src = imageUrl;
  img.alt = getLang() === "en" ? `What it should look like: ${title}` : `Как должно получиться: ${title}`;
  // Тот же баг и то же лекарство, что у деталей пазла (см. buildPieceEl,
  // wrap.addEventListener("dragstart", ...)) — <img> нативно перетаскиваемый
  // браузером элемент, без preventDefault на dragstart браузер перехватывает
  // жест в СВОЙ HTML5 drag-and-drop вместо pointermove ниже: курсор "нельзя",
  // панель не двигается. draggable="false" в разметке (index.html/app.js
  // шаблон) и -webkit-user-drag в CSS уже помогают в Chrome/Firefox/Safari
  // по отдельности, но не везде надёжно сами по себе — dragstart здесь тот
  // же самый третий слой защиты, что и у deталей.
  img.addEventListener("dragstart", e => e.preventDefault(), { signal });

  const MIN_W = 96;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  toggleBtn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
  }, { signal });

  let drag = null;
  img.addEventListener("pointerdown", e => {
    e.stopPropagation(); // не даём фону начать панораму стола
    img.setPointerCapture(e.pointerId);
    const box = panel.getBoundingClientRect(), sBox = stage.getBoundingClientRect();
    drag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, startLeft: box.left - sBox.left, startTop: box.top - sBox.top };
  }, { signal });
  img.addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const sBox = stage.getBoundingClientRect(), box = panel.getBoundingClientRect();
    panel.style.left = `${clamp(drag.startLeft + (e.clientX - drag.startX), 0, sBox.width - box.width)}px`;
    panel.style.top = `${clamp(drag.startTop + (e.clientY - drag.startY), 0, sBox.height - box.height)}px`;
  }, { signal });
  function finishDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag = null;
  }
  img.addEventListener("pointerup", finishDrag, { signal });
  img.addEventListener("pointercancel", finishDrag, { signal });
  img.addEventListener("lostpointercapture", finishDrag, { signal });

  let resize = null;
  handle.addEventListener("pointerdown", e => {
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    resize = { pointerId: e.pointerId, startX: e.clientX, startWidth: panel.getBoundingClientRect().width };
  }, { signal });
  handle.addEventListener("pointermove", e => {
    if (!resize || e.pointerId !== resize.pointerId) return;
    const maxW = stage.getBoundingClientRect().width * 0.9;
    panel.style.width = `${clamp(resize.startWidth + (e.clientX - resize.startX), MIN_W, maxW)}px`;
  }, { signal });
  function finishResize(e) {
    if (!resize || e.pointerId !== resize.pointerId) return;
    resize = null;
  }
  handle.addEventListener("pointerup", finishResize, { signal });
  handle.addEventListener("pointercancel", finishResize, { signal });
  handle.addEventListener("lostpointercapture", finishResize, { signal });
}

const TABLE_BG_KEY = "puzzle_table_bg";

/** Фон стола — свободный выбор цвета через нативный <input type="color">
 *  (см. план «RGB-фон стола»), не пресет светлый/тёмный, как раньше
 *  (см. .light-board — убрано). Личная настройка браузера, не
 *  синхронизируется с сервером — localStorage, тот же приём, что и у
 *  остального чисто локального UI стола (bindPreviewThumb выше). Общая
 *  для соло и комнаты, вызывается из обоих renderTable/renderRoomTable. */
function bindBoardBackground(stage, colorInput, resetBtn, signal) {
  // Точки координатной сетки должны остаться видны на ЛЮБОМ выбранном
  // цвете (см. план — на сплошной заливке без пересчёта их не было видно
  // вовсе на части цветов). Яркость по восприятию (не полная формула
  // относительной светимости sRGB — тут это решение "точки светлые или
  // тёмные", а не точный цветовой расчёт, упрощённых весов достаточно).
  function dotColorFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luma > 0.5 ? "rgba(0,0,0,.22)" : "rgba(255,255,255,.28)";
  }
  function apply(hex) {
    if (hex) {
      stage.style.setProperty("--table-bg", hex);
      stage.style.setProperty("--table-bg-dot", dotColorFor(hex));
      stage.classList.add("custom-bg");
      colorInput.value = hex;
      resetBtn.hidden = false;
    } else {
      stage.style.removeProperty("--table-bg");
      stage.style.removeProperty("--table-bg-dot");
      stage.classList.remove("custom-bg");
      resetBtn.hidden = true;
    }
  }
  apply(localStorage.getItem(TABLE_BG_KEY));

  colorInput.addEventListener("input", () => {
    localStorage.setItem(TABLE_BG_KEY, colorInput.value);
    apply(colorInput.value);
  }, { signal });
  resetBtn.addEventListener("click", () => {
    localStorage.removeItem(TABLE_BG_KEY);
    apply(null);
  }, { signal });
}

async function renderTable(root, puzzleId, signal, queryString) {
  root.innerHTML = `
    <div class="table-screen">
      <div class="table-toolbar">
        <strong id="tableTitle"></strong>
        <div class="spacer"></div>
        <span class="table-progress" id="tableProgress"></span>
        <button class="icon-btn" id="tableHelpBtn" type="button" title="${t("Обучение")}" aria-label="${t("Обучение")}">?</button>
      </div>
      <div class="table-stage" id="stage">
        <div class="table-world" id="world"></div>
        <div class="marquee-select" id="marqueeSelect" hidden></div>
        <div class="preview-panel" id="previewPanel" hidden>
          <img class="preview-thumb" id="previewThumb" alt="" draggable="false">
          <div class="preview-resize-handle" id="previewResizeHandle" title="${t("Изменить размер")}" aria-hidden="true"></div>
        </div>
        <!-- «Назад» — была текстовой ссылкой «← Библиотека» в .table-toolbar,
             теперь иконка в левом верхнем углу доски (не в .board-tools внизу
             — выход со стола не инструмент сборки). -->
        <div class="board-back">
          <a class="btn outlined icon" href="/" title="${t("Библиотека")}" aria-label="${t("Библиотека")}">
            <svg class="icon" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>
          </a>
        </div>
        <!-- Кнопки действий стола — всегда иконками (не только на мобильном,
             см. план п.4), в своей плашке в стиле .zoom-controls, но в другом
             углу, чтобы не пересекаться ни с ним, ни с .preview-thumb. -->
        <!-- Кластер сворачивается в один тоггл (см. план «Выдвигающиеся
             кнопки») — .tools-row внутри анимированно схлопывается по
             max-width/opacity (см. styles.css), сам тоггл остаётся видимым
             всегда, состояние помнит bindCollapsibleCluster (app.js). -->
        <div class="board-tools">
          <button class="btn outlined icon tools-toggle" id="toolsToggleBtn" type="button" title="${t("Свернуть/развернуть инструменты")}" aria-label="${t("Свернуть/развернуть инструменты")}" aria-expanded="true">
            <svg class="icon" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>
          </button>
          <div class="tools-row" id="toolsRow">
            <button class="btn outlined icon" id="shuffleBtn" type="button" title="${t("Перемешать")}" aria-label="${t("Перемешать")}">
              <svg class="icon" viewBox="0 0 24 24"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>
            </button>
            <button class="btn outlined icon" id="previewBtn" type="button" title="${t("Показать картинку")}" aria-label="${t("Показать картинку")}">
              <svg class="icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
            </button>
            <label class="btn outlined icon" id="boardBgBtn" title="${t("Фон стола — выбрать цвет")}" aria-label="${t("Фон стола — выбрать цвет")}">
              <svg class="icon" viewBox="0 0 24 24"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>
              <input type="color" id="boardBgInput" value="#f8f6ef">
            </label>
            <button class="btn outlined icon" id="boardBgResetBtn" type="button" title="${t("Вернуть фон по умолчанию")}" aria-label="${t("Вернуть фон по умолчанию")}" hidden>
              <svg class="icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
            <!-- На тач-устройствах нет Shift — этот тоггл даёт тот же жест
                 (тянуть рамку по пустому месту вместо панорамы), пока включён,
                 одним пальцем. На десктопе Shift+тяни работает и без него —
                 кнопка просто альтернативный способ включить то же самое. -->
            <button class="btn outlined icon" id="selectModeBtn" type="button" title="${t("Режим выделения")}" aria-label="${t("Режим выделения")}" aria-pressed="false">
              <svg class="icon" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="4 3"/></svg>
            </button>
          </div>
        </div>
        <div class="zoom-controls">
          <button class="btn outlined icon" id="zoomInBtn" type="button" title="${t("Приблизить")}" aria-label="${t("Приблизить")}">+</button>
          <button class="btn outlined icon" id="zoomResetBtn" type="button" title="${t("Показать всё")}" aria-label="${t("Показать всё")}">⤢</button>
          <button class="btn outlined icon" id="zoomOutBtn" type="button" title="${t("Отдалить")}" aria-label="${t("Отдалить")}">−</button>
        </div>
        <!-- Подсказка/звук — верхний правый угол (см. план «Выдвигающиеся
             кнопки»), тот же сворачиваемый кластер, что и .board-tools,
             просто якорем на другом углу — тоггл справа, .tools-row
             раскрывается влево (см. styles.css). -->
        <div class="table-widgets">
          <div class="tools-row" id="widgetsRow">
            <button class="btn outlined icon" id="hintBtn" type="button" title="${t("Подсказка")}" aria-label="${t("Подсказка")}">
              <svg class="icon" viewBox="0 0 24 24"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.4 1 1.2 1 2.05V17h6v-2.25c0-.85.4-1.65 1-2.05A7 7 0 0 0 12 2z"/></svg>
            </button>
            <button class="btn outlined icon" id="soundBtn" type="button"></button>
          </div>
          <button class="btn outlined icon tools-toggle" id="widgetsToggleBtn" type="button" title="${t("Свернуть/развернуть инструменты")}" aria-label="${t("Свернуть/развернуть инструменты")}" aria-expanded="true">
            <svg class="icon" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
          </button>
        </div>
      </div>
    </div>`;
  const stage = $(root, "#stage");
  // Обучение (см. assets/onboarding.js) — кнопка открывает тур заново в
  // любой момент; сам тур один на оба стола (соло/комната), шаги про
  // отсутствующие тут элементы (чат/присутствие) молча пропускаются.
  $(root, "#tableHelpBtn").addEventListener("click", () => openTour(), { signal });

  let puzzles;
  try { [puzzles] = await Promise.all([getPuzzles(), ensureDisplayTitleCache()]); } catch { stage.innerHTML = `<p class="state-note">${t("Не удалось загрузить пазл — обновите страницу.")}</p>`; return; }
  if (signal.aborted) return;
  const puzzle = puzzles.find(p => p.id === puzzleId);
  if (!puzzle) { stage.innerHTML = `<p class="state-note">${t("Такого пазла нет.")}</p>`; return; }
  if (puzzle.ownerUserId) {
    stage.innerHTML = `<p class="state-note">${t("Пазлы из своих фото собираются только в комнатах.")} <a class="btn text sm" href="/rooms">${t("К комнатам")}</a></p>`;
    return;
  }
  $(root, "#tableTitle").textContent = puzzleDisplayTitle(puzzle);
  trackGoal("puzzle_started");

  const rows = puzzle.gridRows, cols = puzzle.gridCols;
  const pad = CELL * PAD_FACTOR;
  const boardW = cols * CELL, boardH = rows * CELL;
  // Форма — чисто визуальный выбор конкретной попытки (см. index.html,
  // difficultyAsymmetric), не хранится на сервере для соло — держим в
  // localStorage по puzzleId, чтобы при возврате на уже начатый пазл форма
  // не «прыгала» между обычной и ассиметричной от захода к заходу.
  const shapeKey = `puzzle_shape_${puzzleId}`;
  const asymmetric = queryString
    ? new URLSearchParams(queryString).get("shape") === "asym"
    : localStorage.getItem(shapeKey) === "asym";
  localStorage.setItem(shapeKey, asymmetric ? "asym" : "normal");
  const edges = window.PuzzleShapes.buildEdges(puzzle.seed, rows, cols, { asymmetric });
  // Повороты — тот же приём хранения режима, что у формы выше (см. план
  // «Повороты деталей»): чисто визуальный выбор конкретной попытки,
  // localStorage по puzzleId, чтобы не «прыгало» при возврате.
  const rotateKey = `puzzle_rotate_${puzzleId}`;
  const rotationEnabled = queryString
    ? new URLSearchParams(queryString).get("rotate") === "1"
    : localStorage.getItem(rotateKey) === "1";
  localStorage.setItem(rotateKey, rotationEnabled ? "1" : "0");

  // ── прогресс: сервер для вошедшего, localStorage для гостя ──
  let saved = null;
  if (auth.isAuthenticated()) {
    try {
      const res = await auth.fetch(`/api/puzzles/${encodeURIComponent(puzzle.id)}/progress`);
      if (res.ok) saved = await res.json();
    } catch { /* сессия истекла или сети нет — начинаем как в этой сессии, сохранить не выйдет */ }
  } else {
    saved = localProgress(puzzle.id);
  }
  if (signal.aborted) return;
  // Момент старта — для статистики сборки на окне победы (см. план
  // «Статистика сборки»). Для вошедшего сервер сам хранит и не сдвигает
  // started_at при повторных PUT (см. server.js), просто читаем его
  // обратно; для гостя аналогично храним в самой localStorage-записи (см.
  // saveProgress ниже) — раз назначенное здесь, при первом сохранении, и
  // сохраняющееся дальше как есть. Ничего не начато раньше — startedAt
  // просто "сейчас".
  const startedAt = (saved && saved.startedAt) || Date.now();

  const world = $(root, "#world");
  const progressEl = $(root, "#tableProgress");
  const scatter = scatterLayout(rows, cols, CELL, pad);
  const BOARD_X = scatter.margin, BOARD_Y = scatter.margin;

  world.style.width = scatter.worldW + "px";
  world.style.height = scatter.worldH + "px";

  const outline = document.createElement("div");
  outline.className = "board-outline";
  outline.style.left = BOARD_X + "px";
  outline.style.top = BOARD_Y + "px";
  outline.style.width = boardW + "px";
  outline.style.height = boardH + "px";
  world.appendChild(outline);

  const pieces = new Map();
  let scatterIdx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const savedPiece = saved && Array.isArray(saved.pieces) && saved.pieces.find(pc => pc.r === r && pc.c === c);
      let x, y, rot;
      if (savedPiece) { x = savedPiece.x; y = savedPiece.y; rot = savedPiece.rot || 0; }
      else {
        const cell = scatter.cells[scatterIdx++]; x = cell.x; y = cell.y;
        // Случайный старт из 4 положений — только у свежих деталей (не у
        // уже сохранённых, см. выше) и только если режим включён.
        rot = rotationEnabled ? [0, 90, 180, 270][Math.floor(Math.random() * 4)] : 0;
      }
      pieces.set(`${r},${c}`, { r, c, x, y, rot });
    }
  }

  const selected = new Set(); // ключи "r,c" — текущее ручное выделение (клик/shift-клик)
  function setSelected(keys) {
    selected.clear();
    for (const k of keys) selected.add(k);
    for (const [k, p] of pieces) p.el.classList.toggle("selected", selected.has(k));
  }

  let lastClusterEdgeIds = new Set(); // "r,c|r,c" — вспышка только на НОВЫХ стыковках

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const piece = pieces.get(`${r},${c}`);
      const el = createPieceEl(puzzle.id, r, c, rows, cols, CELL, pad, edges, puzzle.imageUrl, boardW, boardH);
      piece.el = el;
      applyPieceTransform(piece);
      world.appendChild(el);
      bindPieceDrag(el, piece);
    }
  }
  lastClusterEdgeIds = clusterEdgeIds(window.PuzzleClusters.buildClusters(pieces.values(), CELL, SNAP_TOLERANCE).edges);

  /* ── zoom/pan мирового контейнера ── */
  let zoom = 1, panX = 0, panY = 0;
  const ZOOM_MIN = 0.12, ZOOM_MAX = 3.2;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function applyWorldTransform() { world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`; }
  // fitBox — общая математика вписывания прямоугольника мировых координат в
  // stage (см. план «Повороты...» — подсказка вписывает только пару целевых
  // деталей, не весь стол). marginFactor меньше 1 — свободные поля вокруг
  // (0.94 — почти впритык, как раньше у fitView; у подсказки поля пошире,
  // чтобы обе детали не упирались в края экрана).
  function fitBox(x0, y0, x1, y1, marginFactor = 0.94) {
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    const scale = Math.min(rect.width / w, rect.height / h) * marginFactor;
    zoom = clamp(scale, ZOOM_MIN, ZOOM_MAX);
    panX = rect.width / 2 - ((x0 + x1) / 2) * zoom;
    panY = rect.height / 2 - ((y0 + y1) / 2) * zoom;
    applyWorldTransform();
  }
  function fitView() { fitBox(0, 0, scatter.worldW, scatter.worldH); }
  function zoomAt(clientX, clientY, factor) {
    const rect = stage.getBoundingClientRect();
    const cx = clientX - rect.left, cy = clientY - rect.top;
    const wx = (cx - panX) / zoom, wy = (cy - panY) / zoom;
    zoom = clamp(zoom * factor, ZOOM_MIN, ZOOM_MAX);
    panX = cx - wx * zoom;
    panY = cy - wy * zoom;
    applyWorldTransform();
  }
  fitView();

  /* ── авто-панорама к краю доски во время драга детали ──
     bindPieceDrag ниже двигает деталь только по факту pointermove — если
     курсор/палец замерли у самого края stage, новых событий не будет, а
     доска должна продолжать ехать сама. Поэтому отдельный rAF-тик: пока
     activeDrag не пуст и курсор в приграничной полосе, каждый кадр сам
     двигает panX/panY и пересчитывает мировую позицию детали под
     ПОСЛЕДНИМ известным курсором (screenToWorld) — деталь остаётся
     приклеенной к курсору, а не едет вместе с панорамой (простое "накопить
     дельту от старта драга", как было раньше, не учитывало бы смену panX
     во время автоскролла — деталь укатилась бы мимо курсора). */
  const EDGE_MARGIN = 56, EDGE_MAX_SPEED = 16;
  function screenToWorld(clientX, clientY) {
    const r = stage.getBoundingClientRect();
    return { x: (clientX - r.left - panX) / zoom, y: (clientY - r.top - panY) / zoom };
  }
  let activeDrag = null;
  function applyActiveDragPositions() {
    const w = screenToWorld(activeDrag.lastClientX, activeDrag.lastClientY);
    for (const [k, ox, oy] of activeDrag.offsets) {
      const p = pieces.get(k);
      p.x = w.x + ox; p.y = w.y + oy;
      applyPieceTransform(p);
    }
  }
  let edgePanRAF = null;
  function edgePanTick() {
    if (!activeDrag) { edgePanRAF = null; return; }
    const r = stage.getBoundingClientRect();
    const x = activeDrag.lastClientX - r.left, y = activeDrag.lastClientY - r.top;
    const push = (pos, size) => pos < EDGE_MARGIN ? clamp(1 - pos / EDGE_MARGIN, 0, 1)
      : pos > size - EDGE_MARGIN ? -clamp(1 - (size - pos) / EDGE_MARGIN, 0, 1) : 0;
    const vx = push(x, r.width) * EDGE_MAX_SPEED, vy = push(y, r.height) * EDGE_MAX_SPEED;
    if (vx || vy) {
      panX += vx; panY += vy;
      applyWorldTransform();
      applyActiveDragPositions();
    }
    edgePanRAF = requestAnimationFrame(edgePanTick);
  }
  signal.addEventListener("abort", () => {
    activeDrag = null;
    if (edgePanRAF !== null) { cancelAnimationFrame(edgePanRAF); edgePanRAF = null; }
  });

  stage.addEventListener("wheel", e => {
    e.preventDefault();
    const factor = Math.pow(1.0016, -e.deltaY);
    zoomAt(e.clientX, e.clientY, factor);
  }, { passive: false, signal });

  // Пинч на тач — по активным Pointer ID: деталь останавливает всплытие
  // pointerdown (см. bindPieceDrag), поэтому сюда долетают только жесты по фону.
  const active = new Map();
  let panState = null, pinchState = null, clickCandidate = null;
  const midOf = m => { const p = [...m.values()]; return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }; };
  const distOf = m => { const p = [...m.values()]; return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); };

  /* ── массовое выделение рамкой (Shift+тяни по пустому месту доски, или
     тоггл #selectModeBtn для тач — там нет Shift) ──
     Обычный (без Shift/тоггла) драг по фону — панорама, как и был; Shift
     или включённый selectMode меняют смысл жеста на «выделить рамкой», по
     аналогии с тем, что Shift+клик по детали уже означает «добавить к
     выделению» (bindPieceDrag/finish) — тут та же клавиша и то же
     значение, просто для множества деталей сразу. Рамка — в экранных
     координатах (пиксели относительно stage), проверка пересечения с
     деталями — в мировых (screenToWorld), поэтому работает корректно на
     любом zoom/pan. */
  let selectMode = false;
  let marqueeState = null; // { pointerId, startX, startY, baseSelected }
  const marqueeEl = $(root, "#marqueeSelect");
  function updateMarqueeRect(x0, y0, x1, y1) {
    const r = stage.getBoundingClientRect();
    marqueeEl.style.left = `${Math.min(x0, x1) - r.left}px`;
    marqueeEl.style.top = `${Math.min(y0, y1) - r.top}px`;
    marqueeEl.style.width = `${Math.abs(x1 - x0)}px`;
    marqueeEl.style.height = `${Math.abs(y1 - y0)}px`;
  }
  function updateMarqueeSelection(x0, y0, x1, y1) {
    const w0 = screenToWorld(Math.min(x0, x1), Math.min(y0, y1));
    const w1 = screenToWorld(Math.max(x0, x1), Math.max(y0, y1));
    const size = CELL + 2 * pad; // полный размер SVG детали (с запасом под выступы), см. createPieceEl
    const next = new Set(marqueeState.baseSelected);
    for (const [k, p] of pieces) {
      if (p.x < w1.x && p.x + size > w0.x && p.y < w1.y && p.y + size > w0.y) next.add(k);
    }
    setSelected(next);
  }

  stage.addEventListener("pointerdown", e => {
    // .zoom-controls (а теперь и .board-tools/.board-back/.win-overlay/
    // .table-give-up) тоже исключаем: иначе setPointerCapture ниже
    // перехватывает указатель на #stage раньше, чем браузер успевает
    // синтезировать click на кнопке — колесо мыши работало (свой отдельный
    // wheel-хендлер), а кнопки +/−/⤢ (и, отдельно найденный тот же баг,
    // кнопки в окне победы) не реагировали на клик вовсе.
    if (e.target.closest(".piece") || e.target.closest(".zoom-controls") || e.target.closest(".board-tools")
      || e.target.closest(".board-back") || e.target.closest(".table-widgets") || e.target.closest(".preview-panel")
      || e.target.closest(".win-overlay") || e.target.closest(".table-give-up")) return;
    stage.setPointerCapture(e.pointerId);
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (active.size === 1) {
      if (e.shiftKey || selectMode) {
        marqueeState = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, baseSelected: new Set(selected) };
        marqueeEl.hidden = false;
        updateMarqueeRect(e.clientX, e.clientY, e.clientX, e.clientY);
        clickCandidate = null;
      } else {
        panState = { startX: e.clientX, startY: e.clientY, originX: panX, originY: panY };
        stage.classList.add("panning");
        clickCandidate = { x: e.clientX, y: e.clientY };
      }
    } else if (active.size === 2) {
      panState = null;
      marqueeState = null;
      marqueeEl.hidden = true;
      pinchState = { lastDist: distOf(active), lastMid: midOf(active) };
      clickCandidate = null;
    }
  }, { signal });

  stage.addEventListener("pointermove", e => {
    if (clickCandidate && Math.hypot(e.clientX - clickCandidate.x, e.clientY - clickCandidate.y) > 4) clickCandidate = null;
    if (!active.has(e.pointerId)) return;
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (marqueeState && e.pointerId === marqueeState.pointerId) {
      updateMarqueeRect(marqueeState.startX, marqueeState.startY, e.clientX, e.clientY);
      updateMarqueeSelection(marqueeState.startX, marqueeState.startY, e.clientX, e.clientY);
      return;
    }
    if (active.size === 2) {
      const mid = midOf(active), dist = distOf(active);
      if (pinchState) {
        const rect = stage.getBoundingClientRect();
        const oldCx = pinchState.lastMid.x - rect.left, oldCy = pinchState.lastMid.y - rect.top;
        const wx = (oldCx - panX) / zoom, wy = (oldCy - panY) / zoom;
        zoom = clamp(zoom * (dist / pinchState.lastDist), ZOOM_MIN, ZOOM_MAX);
        const newCx = mid.x - rect.left, newCy = mid.y - rect.top;
        panX = newCx - wx * zoom;
        panY = newCy - wy * zoom;
        applyWorldTransform();
      }
      pinchState = { lastDist: dist, lastMid: mid };
    } else if (active.size === 1 && panState) {
      panX = panState.originX + (e.clientX - panState.startX);
      panY = panState.originY + (e.clientY - panState.startY);
      applyWorldTransform();
    }
  }, { signal });

  function endPointer(e) {
    active.delete(e.pointerId);
    if (marqueeState && e.pointerId === marqueeState.pointerId) {
      marqueeState = null;
      marqueeEl.hidden = true;
      clickCandidate = null;
      return;
    }
    if (active.size === 1) {
      const [, p] = [...active.entries()][0];
      panState = { startX: p.x, startY: p.y, originX: panX, originY: panY };
      pinchState = null;
    } else if (active.size === 0) {
      panState = null; pinchState = null;
      stage.classList.remove("panning");
    }
    if (clickCandidate && selected.size) setSelected([]);
    clickCandidate = null;
  }
  stage.addEventListener("pointerup", endPointer, { signal });
  stage.addEventListener("pointercancel", endPointer, { signal });

  $(root, "#zoomInBtn").addEventListener("click", () => {
    const r = stage.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25);
  }, { signal });
  $(root, "#zoomOutBtn").addEventListener("click", () => {
    const r = stage.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.8);
  }, { signal });
  $(root, "#zoomResetBtn").addEventListener("click", fitView, { signal });
  window.addEventListener("resize", fitView, { signal });

  bindPreviewThumb(stage, $(root, "#previewPanel"), $(root, "#previewThumb"), $(root, "#previewResizeHandle"), $(root, "#previewBtn"), puzzle.imageUrl, puzzleDisplayTitle(puzzle), signal);

  bindBoardBackground(stage, $(root, "#boardBgInput"), $(root, "#boardBgResetBtn"), signal);

  // Тач-замена Shift для рамки выделения — см. комментарий у marqueeState
  // выше. На десктопе не нужна (там уже работает Shift+тяни), но не мешает
  // ей — оба способа включают одно и то же условие в pointerdown.
  $(root, "#selectModeBtn").addEventListener("click", e => {
    selectMode = !selectMode;
    e.currentTarget.setAttribute("aria-pressed", String(selectMode));
  }, { signal });

  $(root, "#shuffleBtn").addEventListener("click", () => {
    // Любую уже состыкованную пару/кластер (не только самый большой) не
    // трогаем — «встряхнуть оставшуюся кучу», а не собрать заново с нуля.
    // Риска потерять прогресс нет, подтверждение (confirm) не нужно.
    const next = planShuffle(pieces, rows, cols, CELL, pad, SNAP_TOLERANCE, BOARD_X, BOARD_Y);
    if (!next) return; // всё уже в одном кластере — мешать нечего
    for (const [k, pos] of next) {
      const p = pieces.get(k);
      p.x = pos.x; p.y = pos.y;
      applyPieceTransform(p);
    }
    scheduleSave();
  }, { signal });

  // Подсказка (см. план) — случайная ещё не состыкованная пара соседних
  // деталей: подводим камеру и подсвечиваем обе на пару секунд. Ничего не
  // двигает и не сохраняет — чисто визуальная наводка.
  $(root, "#hintBtn").addEventListener("click", () => {
    const pair = pickHintPair(pieces);
    if (!pair) return;
    const [a, b] = pair;
    const size = CELL + 2 * pad;
    fitBox(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x) + size, Math.max(a.y, b.y) + size, 0.5);
    for (const p of [a, b]) {
      p.el.classList.add("hint-glow");
      setTimeout(() => p.el.classList.remove("hint-glow"), 3000);
    }
  }, { signal });
  bindSoundButton($(root, "#soundBtn"), signal);
  bindCollapsibleCluster($(root, "#toolsToggleBtn"), $(root, "#toolsRow"), "puzzle_tools_collapsed", signal);
  bindCollapsibleCluster($(root, "#widgetsToggleBtn"), $(root, "#widgetsRow"), "puzzle_widgets_collapsed", signal);

  /* ── перетаскивание детали: группа = объединение кластеров текущего выделения ──
     activeDrag — общее (не per-piece) состояние, см. блок авто-панорамы
     выше: rAF-тику edgePanTick нужно знать о текущем драге независимо от
     того, какая именно деталь его начала. */
  function bindPieceDrag(el, piece) {
    let moved = false;
    const key = `${piece.r},${piece.c}`;

    el.addEventListener("pointerdown", e => {
      e.stopPropagation(); // не даём фону начать панораму
      el.setPointerCapture(e.pointerId);
      moved = false;
      // Клик по детали выделяет весь уже собранный сегмент, в который она
      // входит (не только саму деталь) — тащить всё равно будет весь
      // кластер целиком (groupSet ниже строится тем же buildClusters),
      // выделение теперь отражает это сразу, а не только во время драга.
      const { clusterOf, members } = window.PuzzleClusters.buildClusters(pieces.values(), CELL, SNAP_TOLERANCE);
      if (!(selected.has(key) && selected.size > 1)) setSelected(members.get(clusterOf.get(key)));
      const groupSet = new Set();
      for (const k of selected) for (const m of members.get(clusterOf.get(k))) groupSet.add(m);
      // Смещение каждой детали от мировой точки под курсором в момент
      // начала драга (не от абсолютной позиции детали) — так деталь
      // остаётся под курсором даже если panX/panY поменяются во время
      // драга без единого pointermove (см. edgePanTick).
      const w0 = screenToWorld(e.clientX, e.clientY);
      const offsets = [...groupSet].map(k => {
        const p = pieces.get(k);
        p.el.classList.add("dragging");
        return [k, p.x - w0.x, p.y - w0.y];
      });
      activeDrag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, offsets, draggingKeys: groupSet, lastClientX: e.clientX, lastClientY: e.clientY };
      if (edgePanRAF === null) edgePanRAF = requestAnimationFrame(edgePanTick);
    }, { signal });

    el.addEventListener("pointermove", e => {
      if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
      const dx0 = e.clientX - activeDrag.startX, dy0 = e.clientY - activeDrag.startY;
      if (!moved && Math.hypot(dx0, dy0) > 4) moved = true;
      activeDrag.lastClientX = e.clientX; activeDrag.lastClientY = e.clientY;
      applyActiveDragPositions();
    }, { signal });

    function finish(e) {
      if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
      const { offsets, draggingKeys } = activeDrag;
      activeDrag = null;
      // Отменяем ещё не сработавший кадр авто-панорамы явно, а не ждём,
      // пока edgePanTick сам себя погасит увидев activeDrag===null — иначе
      // при очень быстром повторном драге (новый pointerdown раньше, чем
      // успел прийти предыдущий rAF) сработает "if (edgePanRAF === null)"
      // в pointerdown и НЕ запустит новый цикл, решив, что старый ещё жив.
      if (edgePanRAF !== null) { cancelAnimationFrame(edgePanRAF); edgePanRAF = null; }
      for (const [k] of offsets) pieces.get(k).el.classList.remove("dragging");
      if (!moved) {
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        if (additive) {
          const next = new Set(selected);
          if (next.has(key)) next.delete(key); else next.add(key);
          setSelected(next);
        } else {
          setSelected(clusterMembersOf(pieces, key));
        }
        return;
      }
      window.PuzzleClusters.stitchGroup(pieces, draggingKeys, CELL, SNAP_TOLERANCE);
      for (const k of draggingKeys) applyPieceTransform(pieces.get(k));
      const { members, edges } = window.PuzzleClusters.buildClusters(pieces.values(), CELL, SNAP_TOLERANCE);
      const { nextIds, newCount } = flashClusterEdges(pieces, lastClusterEdgeIds, edges);
      lastClusterEdgeIds = nextIds;
      if (newCount > 0) playConnectSound();
      updateProgressLabel(window.PuzzleClusters.connectedPiecesCount(members), rows * cols);
      setSelected([]);
      scheduleSave();
    }
    el.addEventListener("pointerup", finish, { signal });
    el.addEventListener("pointercancel", finish, { signal });
    // Подстраховка от «вечно тащим» (см. расследование бага с прогрессом):
    // pointerup/pointercancel не гарантированно долетают при нештатном
    // завершении жеста (потеря фокуса окна, вкладка свёрнута, ОС перехватила
    // жест) — lostpointercapture по спецификации срабатывает ВСЕГДА, когда
    // элемент теряет захват указателя, каким бы ни был повод, поэтому это
    // надёжная точка для финального finish() и очистки activeDrag.
    el.addEventListener("lostpointercapture", finish, { signal });
    // Поворот (см. план «Повороты деталей») — двойной клик/тап. Только у
    // ОДИНОЧНОЙ детали: деталь внутри уже собранного кластера (>1) физически
    // уже стоит вертикально (buildClusters требует rot===0 для стыковки, см.
    // puzzle-clusters.js), крутить её второй раз незачем.
    el.addEventListener("dblclick", () => {
      if (clusterMembersOf(pieces, key).size > 1) return;
      piece.rot = ((piece.rot || 0) + 90) % 360;
      window.PuzzleClusters.stitchGroup(pieces, new Set([key]), CELL, SNAP_TOLERANCE);
      applyPieceTransform(piece);
      const { members, edges } = window.PuzzleClusters.buildClusters(pieces.values(), CELL, SNAP_TOLERANCE);
      const { nextIds, newCount } = flashClusterEdges(pieces, lastClusterEdgeIds, edges);
      lastClusterEdgeIds = nextIds;
      if (newCount > 0) playConnectSound();
      updateProgressLabel(window.PuzzleClusters.connectedPiecesCount(members), rows * cols);
      scheduleSave();
    }, { signal });
  }

  /* ── сохранение прогресса ── */
  let saveTimer = null;
  let announced = !!(saved && saved.completedAt);
  function updateProgressLabel(placed, total) {
    progressEl.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = `${placed}/${total}`;
    progressEl.append(b, document.createTextNode(getLang() === "en" ? " pieces placed" : " деталей собрано"));
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveProgress(); }, 500);
  }
  async function saveProgress() {
    const total = rows * cols;
    // placed:false — wire-формат остаётся для совместимости со старой БД,
    // но клиент нигде не читает это поле обратно, только пишет заглушку.
    const arr = [...pieces.values()].map(p => ({ r: p.r, c: p.c, x: p.x, y: p.y, placed: false }));
    const placed = computePiecesPlaced(pieces, CELL, SNAP_TOLERANCE);
    updateProgressLabel(placed, total);
    const payload = { pieces: arr, piecesPlaced: placed, piecesTotal: total };

    if (auth.isAuthenticated()) {
      try {
        const res = await auth.fetch(`/api/puzzles/${encodeURIComponent(puzzle.id)}/progress`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), keepalive: true,
        });
        if (res.ok) {
          const data = await res.json();
          if (data.completedAt && !announced) { announced = true; showWin(); }
        }
      } catch { /* AuthRequiredError и подобное — просто не сохранилось на этот раз */ }
    } else {
      const prev = localProgress(puzzle.id);
      const completedAt = isPuzzleSolved(pieces, CELL, SNAP_TOLERANCE, total) ? ((prev && prev.completedAt) || Date.now()) : null;
      // updatedAt — только у гостя (сервер уже хранит его в puzzle_progress.
      // updated_at) — нужен, чтобы «Продолжить сборку» над библиотекой
      // (см. план, inProgressPuzzles) могла сортировать по свежести и для
      // гостя тоже, не только для вошедшего. startedAt — тот же захваченный
      // при загрузке момент (см. выше), просто перезаписываем его же на
      // каждое сохранение, чтобы он не терялся между сборками.
      localStorage.setItem(localKey(puzzle.id), JSON.stringify({ ...payload, startedAt, completedAt, updatedAt: Date.now() }));
      if (completedAt && !announced) { announced = true; showWin(); }
    }
  }
  updateProgressLabel(computePiecesPlaced(pieces, CELL, SNAP_TOLERANCE), rows * cols);
  if (announced) {
    // Уже был собран раньше (пришли на готовый пазл заново) — витрину «Готово»
    // не выскакиваем сразу поверх стола, достаточно бейджа в тулбаре/библиотеке.
  }

  function showWin() {
    trackGoal("puzzle_completed");
    const overlay = document.createElement("div");
    overlay.className = "win-overlay";
    const card = document.createElement("div");
    card.className = "win-card";
    const img = document.createElement("img");
    img.className = "win-image"; img.src = puzzle.imageUrl; img.alt = puzzleDisplayTitle(puzzle);
    const h2 = document.createElement("h2"); h2.textContent = t("Готово!");
    const displayTitle = puzzleDisplayTitle(puzzle);
    const p = document.createElement("p"); p.textContent = getLang() === "en" ? `Puzzle "${displayTitle}" is complete.` : `Пазл «${displayTitle}» собран.`;
    const stats = buildStatsBlock(startedAt, Date.now(), rows * cols);
    const rating = buildRatingWidget(puzzle, signal);
    const actions = document.createElement("div");
    actions.className = "win-actions";
    // Соло-стол показывает только ПУБЛИЧНЫЕ библиотечные пазлы (своё фото
    // отбивается раньше, см. начало renderTable, «только в комнатах») —
    // ownerUserId тут всегда null, кнопка нужна без условия.
    const shareBtn = document.createElement("button");
    shareBtn.className = "btn outlined icon"; shareBtn.type = "button";
    shareBtn.title = t("Скопировать ссылку на пазл"); shareBtn.setAttribute("aria-label", shareBtn.title);
    shareBtn.innerHTML = SHARE_ICON;
    // /puzzle/:id, не /table/:id — ссылка ведёт на страницу пазла, не на
    // прямой стол (см. план «Страница пазла вместо превью-модалки»).
    bindShareButton(shareBtn, () => `${location.origin}/puzzle/${encodeURIComponent(puzzle.id)}`);
    const stayBtn = document.createElement("button");
    stayBtn.className = "btn outlined"; stayBtn.type = "button"; stayBtn.textContent = t("Остаться");
    stayBtn.addEventListener("click", () => overlay.remove());
    const homeBtn = document.createElement("button");
    homeBtn.className = "btn filled"; homeBtn.type = "button"; homeBtn.textContent = t("На главную");
    homeBtn.addEventListener("click", () => { navigate("/"); });
    actions.append(shareBtn, stayBtn, homeBtn);
    card.append(img, h2, p, stats, rating, actions);
    overlay.appendChild(card);
    stage.appendChild(overlay);
    launchConfetti(overlay);
    playWinSound();
  }

  // Флаш сохранения при уходе со стола (смена маршрута), сворачивании вкладки
  // или закрытии страницы — иначе последние секунды сборки потерялись бы.
  signal.addEventListener("abort", () => { clearTimeout(saveTimer); saveProgress(); });
  window.addEventListener("visibilitychange", () => { if (document.hidden) { clearTimeout(saveTimer); saveProgress(); } }, { signal });
  window.addEventListener("pagehide", () => { clearTimeout(saveTimer); saveProgress(); }, { signal });
}

/* ───────────────────────── комнаты: сокет-обвязка ───────────────────────── */

function wsUrlFor(path) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}

/** WebSocket-обёртка с автопереподключением (экспоненциальная задержка,
 *  максимум 10с) и троттлингом на вызывающей стороне (см. throttle ниже).
 *  Токен запрашивается заново при каждой попытке подключения — уже
 *  просроченный к моменту переподключения токен getAccessToken() сам
 *  обновит.
 *
 *  Браузерный WebSocket не доносит до JS причину отказа при провале
 *  хэндшейка (403/404/410 от сервера видны как обычный close без кода) —
 *  раньше это значило бесконечный тихий ретрай с вечным "переподключение…"
 *  на экране, даже когда причина никогда не исчезнет сама (не тот сеанс,
 *  доступ отозван и т.п.). MAX_ATTEMPTS — потолок, после которого перестаём
 *  долбиться и явно сообщаем через onGiveUp, а не тонем в ретраях молча. */
function connectRoomSocket({ roomId, sessionId, signal, onMessage, onOpen, onClose, onGiveUp }) {
  let socket = null, attempt = 0, stopped = false;
  const MAX_ATTEMPTS = 8;

  function scheduleRetry() {
    if (stopped || signal.aborted) return;
    attempt++;
    if (attempt > MAX_ATTEMPTS) { onGiveUp && onGiveUp(); return; }
    setTimeout(open, Math.min(10000, 500 * 2 ** attempt));
  }

  async function open() {
    if (stopped || signal.aborted) return;
    // Аноним подключается вообще без токена (auth.getAccessToken() у него
    // всегда пуст — раньше это уводило сюда в бесконечный ретрай) — сервер
    // сам разберётся по cookie puzzle_anon, которую браузер шлёт на
    // апгрейд-запрос сам (см. план «анонимные комнаты»).
    let tokenParam = "";
    if (auth.isAuthenticated()) {
      const token = await auth.getAccessToken();
      if (!token) { scheduleRetry(); return; }
      tokenParam = `?token=${encodeURIComponent(token)}`;
    }
    const url = wsUrlFor(`/ws/rooms/${encodeURIComponent(roomId)}/sessions/${encodeURIComponent(sessionId)}${tokenParam}`);
    socket = new WebSocket(url);
    socket.addEventListener("open", () => { attempt = 0; onOpen && onOpen(); });
    socket.addEventListener("message", e => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      onMessage(msg);
    });
    socket.addEventListener("close", () => {
      onClose && onClose();
      scheduleRetry();
    });
    socket.addEventListener("error", () => socket.close());
  }
  open();
  signal.addEventListener("abort", () => { stopped = true; if (socket) socket.close(); });

  return { send(obj) { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj)); } };
}

function throttle(fn, ms) {
  let last = 0, pending = null;
  return (...args) => {
    const t = performance.now();
    if (t - last >= ms) { last = t; clearTimeout(pending); fn(...args); }
    else { clearTimeout(pending); pending = setTimeout(() => { last = performance.now(); fn(...args); }, ms - (t - last)); }
  };
}

/* ───────────────────────── комнаты: список ───────────────────────── */

function fmtDate(ts) {
  try { return new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}

/** «Собрано за N минут» — на окне победы и на странице пазла (см. план
 *  «Статистика сборки»). Просто честный wall-clock между стартом
 *  (puzzle_progress.started_at / room_sessions.startedAt) и завершением —
 *  если пазл откладывали на несколько дней и потом доделали, так и
 *  покажет: отделить активное время от простоя нечем, сервер считает
 *  только сам факт старта/завершения, не сессии активности. */
function formatDuration(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  if (totalMin < 1) return t("меньше минуты");
  if (totalMin < 60) return `${totalMin} ${tn(totalMin, ["минута", "минуты", "минут"], ["minute", "minutes"])}`;
  const totalHours = Math.floor(totalMin / 60);
  const restMin = totalMin % 60;
  if (totalHours < 24) {
    const hPart = `${totalHours} ${tn(totalHours, ["час", "часа", "часов"], ["hour", "hours"])}`;
    return restMin > 0 ? `${hPart} ${restMin} ${tn(restMin, ["минута", "минуты", "минут"], ["minute", "minutes"])}` : hPart;
  }
  const days = Math.floor(totalHours / 24);
  const restHours = totalHours % 24;
  const dPart = `${days} ${tn(days, ["день", "дня", "дней"], ["day", "days"])}`;
  return restHours > 0 ? `${dPart} ${restHours} ${tn(restHours, ["час", "часа", "часов"], ["hour", "hours"])}` : dPart;
}

/** Блок «Время сборки / Деталей» — общий для обоих showWin (соло/комната,
 *  см. renderTable/renderRoomTable) и для блока «своя статистика» на
 *  странице пазла (renderPuzzlePage) — тот же вид везде, тот же
 *  .win-stat*, что и рядом стоящий .win-rating (см. styles.css). */
function buildStatsBlock(startedAt, completedAt, piecesTotal) {
  const wrap = document.createElement("div");
  wrap.className = "win-stats";
  const items = [
    [t("Время сборки"), formatDuration(Math.max(0, completedAt - startedAt))],
    [t("Деталей"), String(piecesTotal)],
  ];
  for (const [label, value] of items) {
    const row = document.createElement("div");
    row.className = "win-stat";
    const l = document.createElement("span"); l.className = "win-stat-label"; l.textContent = label;
    const v = document.createElement("b"); v.className = "win-stat-value"; v.textContent = value;
    row.append(l, v);
    wrap.appendChild(row);
  }
  return wrap;
}

/** Ярлыки участников комнаты для списка/presence — анонимным (id с
 *  префиксом "anon:", см. server.js/getOrCreateAnonIdentity) присваиваем
 *  "Гость"/"Гость 2"/… по порядку появления в переданном списке, у
 *  настоящих — имя/логин, как раньше. idKey — поле с идентификатором:
 *  "user_id" у списка участников комнаты (room.members, сырые поля из
 *  SQLite), "id" у presence из WS (см. server.js presenceList). */
function roomMemberLabels(members, idKey) {
  let guestN = 0;
  return members.map(m => {
    if (typeof m[idKey] === "string" && m[idKey].startsWith("anon:")) {
      guestN++;
      return getLang() === "en"
        ? (guestN === 1 ? "Guest" : `Guest ${guestN}`)
        : (guestN === 1 ? "Гость" : `Гость ${guestN}`);
    }
    return m.name || m.username || t("участник");
  });
}

/** Русское склонение по числу — дословно как в Movies (plural). */
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
}

const SHARE_ICON = '<svg class="icon" viewBox="0 0 24 24"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><path d="M8 12h8"/></svg>';
const SHARE_ICON_DONE = '<svg class="icon" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
/** Кнопка «Поделиться» — копирует публичную ссылку на пазл (см. план
 *  «Поделиться из превью и окна победы»). getUrl вызывается В МОМЕНТ
 *  клика, не заранее — в превью-модалке ссылка меняется вместе с выбором
 *  сложности (см. openPuzzlePreviewModal), а не фиксируется при открытии.
 *  Общая на превью-модалку (статичная модалка, переиспользуется между
 *  открытиями — .onclick=, не addEventListener, иначе каждый повторный
 *  вызов копил бы ещё один обработчик на тот же узел) и оба окна победы
 *  (соло/комната, там наоборот — свежий узел на каждый показ, но .onclick
 *  работает и для него точно так же). Раньше была своя копия прямо в
 *  тулбаре стола, теперь кнопки там нет вообще (см. план «Поделиться
 *  иначе» — на самой доске это было не особо нужно). getUrl() может
 *  вернуть falsy (приватный пазл, ещё не в общей библиотеке) — тогда клик
 *  просто ничего не делает, кнопка обычно и не показана в этом случае
 *  вовсе (см. вызовы). */
function bindShareButton(btn, getUrl) {
  let flashTimer = null;
  btn.onclick = async () => {
    const url = getUrl();
    if (!url) return;
    try { await navigator.clipboard.writeText(url); }
    catch { return; /* буфер недоступен — тихо промолчим */ }
    clearTimeout(flashTimer);
    btn.title = t("Скопировано");
    btn.setAttribute("aria-label", btn.title);
    btn.innerHTML = SHARE_ICON_DONE;
    flashTimer = setTimeout(() => {
      btn.title = t("Скопировать ссылку на пазл");
      btn.setAttribute("aria-label", btn.title);
      btn.innerHTML = SHARE_ICON;
    }, 1800);
  };
}

/** Оценка пазла по 5-балльной шкале на окне победы (см. план «Оценка
 *  пазла на окне победы») — общая на соло и комнатное showWin (см. вызовы
 *  ниже), сама решает свою судьбу: подхватывает уже стоящую оценку (если
 *  пазл переигрывают), шлёт PUT при клике, не блокирует ничего вокруг —
 *  ошибка сети тут не критична, просто тихо не сохранится. roomFetch (не
 *  auth.fetch) — оценивать можно и без входа, как и саму сборку. */
function buildRatingWidget(puzzle, signal) {
  const wrap = document.createElement("div");
  wrap.className = "win-rating";
  const label = document.createElement("p");
  label.className = "win-rating-label";
  label.textContent = t("Оцените пазл:");
  const stars = document.createElement("div");
  stars.className = "win-rating-stars";
  stars.setAttribute("role", "radiogroup");
  stars.setAttribute("aria-label", t("Оценка"));
  const note = document.createElement("p");
  note.className = "win-rating-note";
  note.hidden = true;

  const buttons = [];
  let mine = 0;
  function paint(value) {
    buttons.forEach((b, i) => b.classList.toggle("filled", i < value));
  }
  for (let i = 1; i <= 5; i++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "star";
    btn.textContent = "★";
    btn.setAttribute("aria-label", `${i} ${tn(i, ["звезда", "звезды", "звёзд"], ["star", "stars"])}`);
    btn.addEventListener("click", () => submit(i), { signal });
    btn.addEventListener("mouseenter", () => paint(i), { signal });
    buttons.push(btn);
    stars.appendChild(btn);
  }
  stars.addEventListener("mouseleave", () => paint(mine), { signal });

  async function submit(value) {
    mine = value;
    paint(value);
    note.hidden = true;
    try {
      await roomFetch(`/api/puzzles/${encodeURIComponent(puzzle.id)}/rating`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rating: value }),
      });
      note.textContent = t("Спасибо за оценку!");
      note.hidden = false;
    } catch { /* тихо — оценка не критична, окно не блокируем */ }
  }

  roomFetch(`/api/puzzles/${encodeURIComponent(puzzle.id)}/rating`)
    .then(r => r.ok ? r.json() : null)
    .then(data => { if (data && data.mine) { mine = data.mine; paint(mine); } })
    .catch(() => {});

  wrap.append(label, stars, note);
  return wrap;
}

/* Конфетти на окне победы — канвас поверх win-overlay, без библиотек.
   Уважает prefers-reduced-motion (просто не запускается). Останавливается
   сама, если оверлей убрали досрочно («Остаться»/«В комнату») — проверяем
   overlay.isConnected на каждом кадре вместо отдельного слушателя. */
function launchConfetti(overlay) {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const rect = overlay.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const canvas = document.createElement("canvas");
  canvas.className = "confetti-canvas";
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  overlay.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const COLORS = ["#ff6b6b", "#feca57", "#48dbfb", "#1dd1a1", "#ff9ff3", "#54a0ff"];
  const particles = Array.from({ length: 140 }, () => ({
    x: Math.random() * rect.width,
    y: -20 - Math.random() * rect.height * 0.6,
    w: 6 + Math.random() * 5,
    h: 8 + Math.random() * 6,
    color: COLORS[(Math.random() * COLORS.length) | 0],
    vx: (Math.random() - 0.5) * 2,
    vy: 2 + Math.random() * 2.5,
    rot: Math.random() * Math.PI * 2,
    vrot: (Math.random() - 0.5) * 0.2,
    sway: Math.random() * Math.PI * 2,
  }));

  const duration = 3000;
  const start = performance.now();
  function frame(now) {
    if (!overlay.isConnected) return;
    const elapsed = now - start;
    ctx.clearRect(0, 0, rect.width, rect.height);
    const fade = elapsed > duration - 500 ? Math.max(0, 1 - (elapsed - (duration - 500)) / 500) : 1;
    for (const p of particles) {
      p.sway += 0.05;
      p.x += p.vx + Math.sin(p.sway) * 0.6;
      p.y += p.vy;
      p.rot += p.vrot;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (elapsed < duration) requestAnimationFrame(frame);
    else canvas.remove();
  }
  requestAnimationFrame(frame);
}

/* ───────────────────────── звук (см. план «Повороты деталей + звук +
 * подсказка») ─────────────────────────
 * Синтезированные тоны через Web Audio, без файлов-ассетов — короткий щелчок
 * на стыковку (playConnectSound) и более протяжный на победу (playWinSound).
 * Один AudioContext на вкладку, создаётся лениво при первом звуке (браузеры
 * не разрешают создавать/резюмировать контекст ДО первого пользовательского
 * жеста — к моменту первой стыковки жест уже был, так что resume() тут
 * не нужен). Настройка — тумблер #soundBtn в тулбаре стола (renderTable/
 * renderRoomTable), состояние в localStorage, читается ЖИВЬЁМ на каждый
 * звук (не кэшируется в переменную) — так переключение мгновенно действует
 * даже если тумблер переключили уже после того, как стол отрисовался. */
const SOUND_KEY = "puzzle_sound";
function soundEnabled() { return localStorage.getItem(SOUND_KEY) !== "off"; }
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
  return audioCtx;
}
/** tone({freq, dur, type, gain}) — один осциллятор с плавной огибающей
 *  громкости (без щелчков атаки/отсечки на границах). */
function tone({ freq, dur, type = "sine", gain = 0.16, delay = 0 }) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}
function playConnectSound() {
  if (!soundEnabled()) return;
  tone({ freq: 720, dur: 0.09, type: "triangle" });
}
function playWinSound() {
  if (!soundEnabled()) return;
  // Короткое взбегающее трезвучие — три ноты одна за другой (delay).
  tone({ freq: 523.25, dur: 0.22, type: "sine", gain: 0.14 });
  tone({ freq: 659.25, dur: 0.22, type: "sine", gain: 0.14, delay: 0.09 });
  tone({ freq: 783.99, dur: 0.32, type: "sine", gain: 0.16, delay: 0.18 });
}
function applySoundButton(btn) {
  const on = soundEnabled();
  btn.setAttribute("aria-pressed", String(on));
  btn.title = on ? t("Звук — выключить") : t("Звук — включить");
  btn.setAttribute("aria-label", btn.title);
  btn.innerHTML = on ? SOUND_ON_ICON : SOUND_OFF_ICON;
}
const SOUND_ON_ICON = '<svg class="icon" viewBox="0 0 24 24"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M16 8a5 5 0 0 1 0 8"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const SOUND_OFF_ICON = '<svg class="icon" viewBox="0 0 24 24"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M16 9l5 6M21 9l-5 6"/></svg>';
/** Общий обработчик тумблера — переиспользуется соло и комнатой (см.
 *  renderTable/renderRoomTable). */
function bindSoundButton(btn, signal) {
  applySoundButton(btn);
  btn.addEventListener("click", () => {
    localStorage.setItem(SOUND_KEY, soundEnabled() ? "off" : "on");
    applySoundButton(btn);
  }, { signal });
}

/** Свёртывание кластера кнопок (низ-лево .board-tools / верх-право
 *  .table-widgets) в компактную кнопку-тоггл — «выдвигающийся блок» (см.
 *  план): toggleBtn всегда виден, rowEl — остальные кнопки, скрывается
 *  через max-width/opacity (см. .tools-row в styles.css), а не display —
 *  так есть анимация «выезда», а не мгновенное исчезновение. Состояние
 *  запоминается в localStorage (свой ключ на каждый кластер), по умолчанию
 *  развёрнут — не прячем инструменты от тех, кто ещё не знает про тоггл.
 *  Общая на соло и комнату — оба места просто зовут её с разными ключами. */
function bindCollapsibleCluster(toggleBtn, rowEl, storageKey, signal) {
  const apply = collapsed => {
    rowEl.classList.toggle("collapsed", collapsed);
    toggleBtn.closest(".board-tools, .table-widgets")?.classList.toggle("collapsed", collapsed);
    toggleBtn.setAttribute("aria-expanded", String(!collapsed));
  };
  apply(localStorage.getItem(storageKey) === "1");
  toggleBtn.addEventListener("click", () => {
    const collapsed = !rowEl.classList.contains("collapsed");
    localStorage.setItem(storageKey, collapsed ? "1" : "0");
    apply(collapsed);
  }, { signal });
}

const ROOMS_PAGE_SIZE = 5;

// Модалки создания/присоединения — статическая разметка в index.html (вне
// #app, как и accountModalBackdrop выше, живёт постоянно) — привязываем
// один раз здесь; кнопки, которые их ОТКРЫВАЮТ (#createRoomOpenBtn/
// #joinRoomOpenBtn), рендерятся заново при каждом заходе на #/rooms — их
// обработчики вешаются внутри renderRoomsList со своим { signal }.
bindModal("createRoomModalBackdrop", null, "createRoomModalClose");
bindModal("joinRoomModalBackdrop", null, "joinRoomModalClose");
// Открывающая кнопка (#addPuzzleBtn) рендерится внутри renderRoom при каждом
// заходе в комнату — та же схема, что у createRoomOpenBtn/joinRoomOpenBtn
// выше: сама модалка статична в index.html и привязывается один раз здесь.
bindModal("uploadPuzzleModalBackdrop", null, "uploadPuzzleModalClose");
document.getElementById("createRoomBtn").addEventListener("click", async () => {
  const input = document.getElementById("newRoomTitle");
  const title = input.value.trim();
  if (!title) return;
  try {
    const res = await roomFetch("/api/rooms", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
    });
    if (!res.ok) throw new Error("create room failed");
    const room = await res.json();
    trackGoal("room_created");
    input.value = "";
    closeModal("createRoomModalBackdrop");
    navigate(`/room/${encodeURIComponent(room.id)}`);
  } catch { /* останемся на месте, поле не очистится — можно повторить */ }
});
document.getElementById("newRoomTitle").addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("createRoomBtn").click();
});
function goToRoomCode(raw) {
  const code = raw.trim().toUpperCase();
  if (!code) return;
  closeModal("joinRoomModalBackdrop");
  // Переиспользует уже существующий маршрут/экран (см. renderRoomJoin ниже).
  navigate(`/rooms/join/${encodeURIComponent(code)}`);
}
document.getElementById("joinCodeBtn").addEventListener("click", () => {
  goToRoomCode(document.getElementById("joinCodeInput").value);
});
document.getElementById("joinCodeInput").addEventListener("keydown", e => {
  if (e.key === "Enter") goToRoomCode(e.target.value);
});

async function renderRoomsList(root, signal) {
  root.innerHTML = `
    <div class="library-head">
      <h1>${t("Комнаты")}</h1>
      <p>${t("Соберите пазл вместе с друзьями — детали двигаются в реальном времени для всех, кто за столом.")}</p>
    </div>
    <div class="room-actions-row" id="roomActionsRow">
      <button class="btn filled" id="createRoomOpenBtn" type="button">${t("Создать комнату")}</button>
      <button class="btn outlined" id="joinRoomOpenBtn" type="button">${t("Присоединиться к комнате")}</button>
    </div>
    <div class="room-list" id="roomList"><p class="state-note">${t("Загружаем…")}</p></div>
    <div class="pager" id="roomsPager" hidden>
      <button class="btn outlined sm" id="roomsPrevBtn" type="button">${getLang() === "en" ? "← Back" : "← Назад"}</button>
      <span class="muted" id="roomsPagerLabel"></span>
      <button class="btn outlined sm" id="roomsNextBtn" type="button">${getLang() === "en" ? "Next →" : "Вперёд →"}</button>
    </div>`;

  // Комнаты теперь доступны и без входа (см. server.js/
  // getOrCreateAnonIdentity) — список анонимных комнат этого браузера
  // работает так же, как «мои комнаты» у вошедшего, просто ключом служит
  // cookie вместо JWT. Единственное, чего анониму не хватает — списка
  // комнат виден только на ЭТОМ устройстве (cookie не переносится), для
  // этого мягкая подсказка ниже, не блокирующая экран.
  if (!auth.isAuthenticated()) {
    const note = document.createElement("div");
    note.className = "guest-note";
    const span = document.createElement("span");
    span.textContent = t("Войдите, чтобы комната была видна и с других устройств.");
    const btn = document.createElement("button");
    btn.className = "btn tonal sm"; btn.type = "button";
    btn.textContent = t("Войти");
    btn.addEventListener("click", () => auth.login());
    note.append(span, btn);
    $(root, "#roomList").before(note);
  }

  // Пагинация — целиком на фронте, список уже загружен целиком (см.
  // loadRooms) — на масштабе личного проекта заводить свой лимит/оффсет на
  // бэке незачем (тот же приём, что в Movies).
  let rooms = [];
  let roomsPage = 0;

  function renderPage() {
    const list = $(root, "#roomList");
    const pagerEl = $(root, "#roomsPager");
    if (!rooms.length) {
      list.innerHTML = `<p class="state-note">${t("Пока нет ни одной комнаты — создайте первую.")}</p>`;
      pagerEl.hidden = true;
      return;
    }
    const pages = Math.max(1, Math.ceil(rooms.length / ROOMS_PAGE_SIZE));
    roomsPage = Math.min(roomsPage, pages - 1);
    const start = roomsPage * ROOMS_PAGE_SIZE;
    const pageRooms = rooms.slice(start, start + ROOMS_PAGE_SIZE);

    list.innerHTML = "";
    for (const r of pageRooms) {
      const card = document.createElement("article");
      card.className = "room-card";
      card.innerHTML = `
        <h3 class="room-card-title"></h3>
        <p class="room-card-meta"></p>`;
      $(card, ".room-card-title").textContent = r.title;
      $(card, ".room-card-meta").textContent = getLang() === "en"
        ? `${r.membersCount} ${r.membersCount === 1 ? "member" : "members"}`
          + (r.role === "owner" ? " · you're the owner" : "")
          + ` · updated ${fmtDate(r.updatedAt)}`
        : `${r.membersCount} ${plural(r.membersCount, "участник", "участника", "участников")}`
          + (r.role === "owner" ? " · вы владелец" : "")
          + ` · обновлено ${fmtDate(r.updatedAt)}`;
      card.addEventListener("click", () => { navigate(`/room/${encodeURIComponent(r.id)}`); });
      list.appendChild(card);
    }

    const showPager = rooms.length > ROOMS_PAGE_SIZE;
    pagerEl.hidden = !showPager;
    if (showPager) {
      $(root, "#roomsPagerLabel").textContent = pagerLabel(roomsPage + 1, pages);
      $(root, "#roomsPrevBtn").disabled = roomsPage <= 0;
      $(root, "#roomsNextBtn").disabled = roomsPage >= pages - 1;
    }
  }

  async function loadRooms() {
    const list = $(root, "#roomList");
    try {
      const res = await roomFetch("/api/rooms");
      if (!res.ok) throw new Error("rooms fetch failed");
      rooms = await res.json();
    } catch {
      if (!signal.aborted) list.innerHTML = `<p class="state-note">${t("Не удалось загрузить комнаты — обновите страницу.")}</p>`;
      return;
    }
    if (signal.aborted) return;
    renderPage();
  }

  $(root, "#roomsPrevBtn").addEventListener("click", () => { roomsPage = Math.max(0, roomsPage - 1); renderPage(); }, { signal });
  $(root, "#roomsNextBtn").addEventListener("click", () => { roomsPage += 1; renderPage(); }, { signal });
  $(root, "#createRoomOpenBtn").addEventListener("click", () => openModal("createRoomModalBackdrop"), { signal });
  $(root, "#joinRoomOpenBtn").addEventListener("click", () => openModal("joinRoomModalBackdrop"), { signal });

  await loadRooms();
}

/* ───────────────────────── комнаты: экран комнаты ───────────────────────── */

async function renderRoom(root, roomId, signal) {
  root.innerHTML = `
    <div class="library-head"><h1>${t("Комната")}</h1></div>
    <div id="roomBody"><p class="state-note">${t("Загружаем…")}</p></div>`;
  const body = $(root, "#roomBody");

  let room, sessions;
  try {
    const [roomRes, sessionsRes] = await Promise.all([
      roomFetch(`/api/rooms/${encodeURIComponent(roomId)}`),
      roomFetch(`/api/rooms/${encodeURIComponent(roomId)}/sessions`),
      ensureDisplayTitleCache(),
    ]);
    if (roomRes.status === 403) { body.innerHTML = `<p class="state-note">${t("Вы не участник этой комнаты.")}</p>`; return; }
    if (!roomRes.ok) throw new Error("room fetch failed");
    room = await roomRes.json();
    sessions = sessionsRes.ok ? await sessionsRes.json() : [];
  } catch {
    if (!signal.aborted) body.innerHTML = `<p class="state-note">${t("Не удалось загрузить комнату — обновите страницу.")}</p>`;
    return;
  }
  if (signal.aborted) return;

  const inviteUrl = `${location.origin}/rooms/join/${room.joinCode}`;

  body.innerHTML = `
    <div class="room-head">
      <h2 class="room-head-title"></h2>
      ${room.role === "owner" ? `<button class="btn text danger" id="deleteRoomBtn" type="button">${t("Удалить комнату")}</button>` : ""}
    </div>
    <!-- Крупный пунктирный блок с кодом комнаты — тот же паттерн, что в
         Movies (.code-box, renderCodeArea): код кликабелен и копируется
         сам по себе, кнопка рядом — для полной ссылки. Без «Перевыпустить
         код» — этого эндпоинта у Puzzle нет. -->
    <div class="code-box">
      <code id="roomCode" title="${t("Скопировать код")}"></code>
      <button class="btn tonal sm" id="copyInviteLinkBtn" type="button">${t("Скопировать ссылку")}</button>
      <span class="code-box-hint muted" id="roomCodeHint" aria-live="polite" hidden></span>
    </div>
    <div class="room-members" id="roomMembers"></div>
    <div class="room-active" id="roomActive"></div>
    <h3 class="room-section-title">${t("История сборок")}</h3>
    <div class="room-history" id="roomHistory"></div>`;

  $(root, ".room-head-title").textContent = room.title;
  const roomCodeEl = $(root, "#roomCode");
  const roomCodeHint = $(root, "#roomCodeHint");
  roomCodeEl.textContent = room.joinCode;
  let hintTimer = null;
  function flashCopied() {
    clearTimeout(hintTimer);
    roomCodeHint.textContent = t("Скопировано");
    roomCodeHint.hidden = false;
    hintTimer = setTimeout(() => { roomCodeHint.hidden = true; }, 1800);
  }
  roomCodeEl.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(room.joinCode); flashCopied(); } catch { /* буфер недоступен — код и так виден */ }
  }, { signal });
  $(root, "#copyInviteLinkBtn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(inviteUrl); flashCopied(); } catch { /* буфер недоступен — ссылка есть в приглашении */ }
  }, { signal });

  // Удаление комнаты целиком — необратимо (все сборки и история пропадают
  // у всех участников), поэтому двойное подтверждение текстом названия не
  // делаем (это отдельный сервис, не банк), но обычный confirm() — тот же
  // приём, что и у удаления сеанса/участника чуть ниже.
  const deleteRoomBtn = $(root, "#deleteRoomBtn");
  if (deleteRoomBtn) {
    deleteRoomBtn.addEventListener("click", async () => {
      if (!confirm(getLang() === "en" ? `Delete the room "${room.title}"? This removes it for everyone.` : `Удалить комнату «${room.title}»? Она пропадёт у всех участников.`)) return;
      deleteRoomBtn.disabled = true;
      try {
        await deleteRoom(roomId);
        navigate("/rooms");
      } catch {
        deleteRoomBtn.disabled = false;
        alert(t("Не удалось удалить комнату."));
      }
    }, { signal });
  }

  const membersEl = $(root, "#roomMembers");
  membersEl.innerHTML = "";
  const memberLabels = roomMemberLabels(room.members, "user_id");
  // Убрать участника может только владелец комнаты, и не самого себя —
  // owner всегда один, менять роль тут негде и незачем (см. правку
  // «возможность удалять пользователей владельцем комнаты»).
  const canRemoveMembers = room.role === "owner";
  room.members.forEach((m, i) => {
    const chip = document.createElement("span");
    chip.className = "member-chip" + (m.role === "owner" ? " owner" : "");
    const label = document.createElement("span");
    label.textContent = memberLabels[i];
    chip.appendChild(label);
    if (canRemoveMembers && m.role !== "owner") {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "member-chip-remove";
      removeBtn.title = getLang() === "en" ? `Remove "${memberLabels[i]}" from the room` : `Убрать «${memberLabels[i]}» из комнаты`;
      removeBtn.setAttribute("aria-label", removeBtn.title);
      removeBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      removeBtn.addEventListener("click", async () => {
        if (!confirm(getLang() === "en" ? `Remove "${memberLabels[i]}" from the room?` : `Убрать «${memberLabels[i]}» из комнаты?`)) return;
        removeBtn.disabled = true;
        try {
          await removeRoomMember(roomId, m.user_id);
          chip.remove();
        } catch {
          removeBtn.disabled = false;
          alert(t("Не удалось убрать участника."));
        }
      }, { signal });
      chip.appendChild(removeBtn);
    }
    membersEl.appendChild(chip);
  });

  // До MAX_ACTIVE_SESSIONS_PER_ROOM параллельных активных сборок в комнате
  // (временное послабление, см. план) — список карточек 0..5 вместо жёсткого
  // if/else «одна активная ИЛИ пикер». Пикер показывается ВСЕГДА ниже,
  // независимо от числа активных: если лимит достигнут, сервер отобьёт
  // попытку старта 409-м, сообщение поймает playVariant.
  const activeEl = $(root, "#roomActive");
  const activeSessions = room.activeSessions || [];
  activeEl.innerHTML = activeSessions.map(s => `
    <div class="room-active-card">
      <p>${getLang() === "en" ? `Right now the table has "${puzzleDisplayTitle(s.puzzle)}" in progress — ${s.piecesPlaced}/${s.piecesTotal} pieces.` : `Сейчас за столом собирают пазл «${puzzleDisplayTitle(s.puzzle)}» — ${s.piecesPlaced}/${s.piecesTotal} деталей.`}</p>
      <button class="btn filled join-table-btn" type="button" data-session="${s.id}">${t("За стол")}</button>
      <button class="icon-btn xs delete-session-btn" type="button" data-session="${s.id}" data-title="${puzzleDisplayTitle(s.puzzle)}" title="${t("Удалить")}" aria-label="${t("Удалить")}">
        <svg class="icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>`).join("")
    + `<div class="room-section-head"><h3 class="room-section-title">${t("Начать сборку")}</h3>`
    + `<button class="icon-btn tonal" id="addPuzzleBtn" type="button" title="${t("Добавить пазл")}" aria-label="${t("Добавить пазл")}">`
    + '<svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button></div>'
    + `<div class="puzzle-grid" id="roomPuzzleGrid"><p class="state-note">${t("Загружаем пазлы…")}</p></div><p class="state-note" id="sessionLimitNote" hidden></p>`;
  for (const btn of activeEl.querySelectorAll(".join-table-btn")) {
    btn.addEventListener("click", () => {
      navigate(`/room/${encodeURIComponent(roomId)}/table/${encodeURIComponent(btn.dataset.session)}`);
    }, { signal });
  }
  // «Лишний» сеанс, начатый по ошибке — освобождает слот из лимита
  // MAX_ACTIVE_SESSIONS_PER_ROOM. Сервер отобьёт 409-м, если за столом
  // сейчас реально кто-то сидит (см. deleteRoomSession) — в этом случае
  // просто сообщаем и оставляем карточку на месте.
  for (const btn of activeEl.querySelectorAll(".delete-session-btn")) {
    btn.addEventListener("click", async () => {
      const { session: sid, title } = btn.dataset;
      if (!confirm(getLang() === "en" ? `Delete the "${title}" session?` : `Удалить сеанс сборки «${title}»?`)) return;
      btn.disabled = true;
      try {
        await deleteRoomSession(roomId, sid);
        btn.closest(".room-active-card").remove();
      } catch (e) {
        btn.disabled = false;
        alert(e.message === "table not empty" ? t("За этим столом сейчас кто-то сидит — сначала все должны выйти.") : t("Не удалось удалить."));
      }
    }, { signal });
  }

  let puzzles;
  try { puzzles = await getPuzzles(roomId); } catch { $(activeEl, "#roomPuzzleGrid").innerHTML = `<p class="state-note">${t("Не удалось загрузить пазлы.")}</p>`; puzzles = []; }
  if (signal.aborted) return;
  const grid = $(activeEl, "#roomPuzzleGrid");

  async function playVariant(variant, asymmetric, rotate) {
    try {
      const sessionId = await startRoomSession(roomId, variant.id, asymmetric, rotate);
      navigate(`/room/${encodeURIComponent(roomId)}/table/${encodeURIComponent(sessionId)}`);
    } catch (e) {
      if (e.message === "room session limit reached") {
        const note = $(activeEl, "#sessionLimitNote");
        note.hidden = false;
        const limit = typeof e.limit === "number" ? e.limit : MAX_ACTIVE_SESSIONS_PER_ROOM;
        note.textContent = getLang() === "en"
          ? `Reached the limit of simultaneous sessions in this room (${limit}) — finish one to start a new one.`
          : `Достигнут лимит одновременных сборок в комнате (${limit}) — заверши одну, чтобы начать новую.`;
      }
      /* иначе — ошибка сети, пользователь просто попробует кнопку ещё раз */
    }
  }

  // Библиотека в комнате теперь по добавлению, не по умолчанию (см. план
  // «Библиотека в комнате — по добавлению, не по умолчанию») — puzzles тут
  // уже только свои фото ЭТОЙ комнаты + явно добавленные библиотечные (см.
  // server.js, room_added_puzzles), пусто в новой комнате — самое обычное
  // состояние, не ошибка. currentGroups/addedImageUrls живут в замыкании —
  // и сетка, и панель «Из библиотеки» в модалке (см. ниже) читают/пишут их
  // сообща, чтобы не расходиться при добавлении на лету.
  let currentGroups = groupPuzzles(puzzles);
  const addedImageUrls = new Set(currentGroups.map(g => g.imageUrl));

  function paintRoomGrid() {
    grid.innerHTML = "";
    // Прежний empty-state рисовался ВНУТРИ .puzzle-grid (display:grid,
    // колонки minmax(15.5rem,1fr)) — <p>/<button> как отдельные grid-item
    // растягивались каждый на свою колонку/строку, кнопка раздувалась в
    // нечитаемый овал. Правильное место — рядом с сеткой, не внутри нее
    // (тот же приём и класс .category-suggest, что у «Предложите
    // категорию» под библиотекой, см. renderCategorySuggestBox) — сетку на
    // время пустого состояния просто прячем.
    const prevEmpty = $(activeEl, "#roomPuzzlesEmpty");
    if (prevEmpty) prevEmpty.remove();
    if (!currentGroups.length) {
      grid.hidden = true;
      const empty = document.createElement("div");
      empty.className = "category-suggest";
      empty.id = "roomPuzzlesEmpty";
      empty.innerHTML = `
        <div class="category-suggest-icon">
          <svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        </div>
        <h2>${t("В этой комнате пока нет пазлов")}</h2>
        <p>${t("Добавьте первый — из общей библиотеки или загрузите своё фото.")}</p>
        <button class="btn filled sm" type="button">${t("Добавить пазл")}</button>`;
      grid.insertAdjacentElement("afterend", empty);
      $(empty, "button").addEventListener("click", () => openModal("uploadPuzzleModalBackdrop"), { signal });
      return;
    }
    grid.hidden = false;
    // allowDelete НЕ передан (по умолчанию разрешено) — buildCard сам
    // решает, кому показать крестик: владельцу своего фото — «удалить»,
    // любому участнику комнаты (roomId передан) на библиотечном пазле —
    // «убрать из этой комнаты» (см. canRemoveFromRoom в buildCard).
    for (const group of currentGroups) {
      grid.appendChild(buildCard(group, { onPlay: playVariant, roomId }));
    }
  }
  // Добавление карточки на лету (из панели «Из библиотеки» или сразу после
  // своей загрузки) — не полный перерендер: переводит сетку из пустого
  // состояния в обычное, если это первая карточка, иначе просто дописывает.
  function addGroupToRoomGrid(group) {
    currentGroups.push(group);
    addedImageUrls.add(group.imageUrl);
    if (currentGroups.length === 1) { paintRoomGrid(); return; }
    grid.appendChild(buildCard(group, { onPlay: playVariant, roomId }));
  }
  paintRoomGrid();

  $(activeEl, "#addPuzzleBtn").addEventListener("click", () => openModal("uploadPuzzleModalBackdrop"), { signal });
  // Модалка теперь с двумя вкладками (см. index.html) — «Из библиотеки»
  // (renderAddPuzzleLibrary, весь общий каталог с фильтром по категории) и
  // «Загрузить своё фото» (форма, как раньше). Обе монтируются заново на
  // каждый заход в комнату — их innerHTML сам перезаписывается, повторный
  // вызов не накапливает старые формы/обработчики.
  const tabLibraryBtn = document.getElementById("addPuzzleTabLibrary");
  const tabUploadBtn = document.getElementById("addPuzzleTabUpload");
  const libraryMount = document.getElementById("addPuzzleLibraryMount");
  const uploadMount = document.getElementById("uploadPuzzleFormMount");
  function selectAddPuzzleTab(tab) {
    const isLibrary = tab === "library";
    tabLibraryBtn.classList.toggle("active", isLibrary);
    tabUploadBtn.classList.toggle("active", !isLibrary);
    libraryMount.hidden = !isLibrary;
    uploadMount.hidden = isLibrary;
  }
  tabLibraryBtn.addEventListener("click", () => selectAddPuzzleTab("library"), { signal });
  tabUploadBtn.addEventListener("click", () => selectAddPuzzleTab("upload"), { signal });
  selectAddPuzzleTab("library");

  renderAddPuzzleLibrary(libraryMount, roomId, addedImageUrls, signal, addGroupToRoomGrid);

  // Загрузка своего фото по-прежнему требует настоящего входа (POST
  // /api/puzzles и так уже проверяет это на сервере, см. план «анонимные
  // комнаты») — анониму вместо формы подсказка, чтобы не показывать то,
  // что всё равно откажет.
  if (auth.isAuthenticated()) {
    mountUploadForm(uploadMount, roomId, result => {
      addGroupToRoomGrid({ ...result.variants[0], variants: result.variants });
      closeModal("uploadPuzzleModalBackdrop");
    });
  } else {
    uploadMount.innerHTML = `<p class="state-note">${t("Войдите, чтобы добавить своё фото.")}</p><button class="btn tonal sm" id="uploadLoginBtn" type="button">${t("Войти")}</button>`;
    $(uploadMount, "#uploadLoginBtn").addEventListener("click", () => auth.login(), { signal });
  }

  const historyEl = $(root, "#roomHistory");
  const past = sessions.filter(s => s.completedAt);
  if (!past.length) {
    historyEl.innerHTML = `<p class="state-note">${t("Ещё ничего не собрано.")}</p>`;
  } else {
    historyEl.innerHTML = "";
    for (const s of past) {
      const row = document.createElement("div");
      row.className = "history-row";
      row.innerHTML = `
        <div class="history-info">
          <span class="history-puzzle"></span>
          <span class="history-meta"></span>
        </div>
        <div class="history-actions">
          <button class="btn outlined sm history-replay" type="button">${t("Собрать ещё раз")}</button>
          <button class="icon-btn xs history-delete" type="button" title="${t("Удалить")}" aria-label="${t("Удалить")}">
            <svg class="icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>`;
      $(row, ".history-puzzle").textContent = puzzleDisplayTitle(s.puzzle);
      $(row, ".history-meta").textContent = getLang() === "en"
        ? `${s.piecesTotal} pieces · completed ${fmtDate(s.completedAt)}`
        : `${s.piecesTotal} деталей · собран ${fmtDate(s.completedAt)}`;
      // Доступна и когда сейчас уже идёт другой активный сеанс —
      // startRoomSession в этом случае просто перекинет на него (409-ветка).
      $(row, ".history-replay").addEventListener("click", async e => {
        e.target.disabled = true;
        try {
          const newId = await startRoomSession(roomId, s.puzzle.id);
          navigate(`/room/${encodeURIComponent(roomId)}/table/${encodeURIComponent(newId)}`);
        } catch { e.target.disabled = false; }
      }, { signal });
      // Завершённый сеанс — за столом никого уже нет (completedAt выставлен),
      // 409 здесь в норме не встречается, но deleteRoomSession всё равно
      // корректно её обработает, если что-то поменялось между рендером и кликом.
      $(row, ".history-delete").addEventListener("click", async e => {
        if (!confirm(getLang() === "en" ? `Delete the "${puzzleDisplayTitle(s.puzzle)}" session?` : `Удалить сеанс сборки «${puzzleDisplayTitle(s.puzzle)}»?`)) return;
        // currentTarget, не target: клик может попасть на вложенный <svg>/<path>
        // иконки крестика — у них нет свойства disabled, а нужно отключить
        // саму кнопку.
        e.currentTarget.disabled = true;
        try { await deleteRoomSession(roomId, s.id); row.remove(); }
        catch (err) {
          e.currentTarget.disabled = false;
          alert(err.message === "table not empty" ? t("За этим столом сейчас кто-то сидит — сначала все должны выйти.") : t("Не удалось удалить."));
        }
      }, { signal });
      historyEl.appendChild(row);
    }
  }
}

/* ───────────────────────── комнаты: вступление по ссылке ───────────────────────── */

async function renderRoomJoin(root, code, signal) {
  root.innerHTML = `<div id="joinBody"><p class="state-note">${t("Секунду…")}</p></div>`;
  const body = $(root, "#joinBody");

  // Вступление по ссылке теперь работает и без входа (см. план
  // «анонимные комнаты») — roomFetch сам разберётся, JWT это или
  // анонимный cookie.
  try {
    const res = await roomFetch(`/api/rooms/join/${encodeURIComponent(code)}`, { method: "POST" });
    if (!res.ok) throw new Error("join failed");
    const data = await res.json();
    if (signal.aborted) return;
    navigate(`/room/${encodeURIComponent(data.roomId)}`);
  } catch {
    if (!signal.aborted) body.innerHTML = `<p class="state-note">${t("Приглашение не найдено или больше не действует.")}</p>`;
  }
}

/* ───────────────────────── комнаты: стол ───────────────────────── */

/** Структурная копия renderTable (см. выше) — тот же scatterLayout,
 *  createPieceEl, applyPieceTransform, zoom/pan/pinch — БЕЗ ИЗМЕНЕНИЙ
 *  (камера — локальное состояние каждого клиента, синхронизации не
 *  требует). Отличия: раскладка и прогресс приходят по сокету, а не из
 *  фетча сохранённого прогресса; перетаскивание детали шлёт move/place. */
async function renderRoomTable(root, roomId, sessionId, signal) {
  root.innerHTML = `
    <div class="table-screen">
      <div class="table-toolbar">
        <strong id="tableTitle"></strong>
        <div class="spacer"></div>
        <span class="table-progress" id="tableProgress"></span>
        <button class="icon-btn" id="tableHelpBtn" type="button" title="${t("Обучение")}" aria-label="${t("Обучение")}">?</button>
      </div>
      <div class="table-stage" id="stage">
        <div class="table-world" id="world"></div>
        <div class="marquee-select" id="marqueeSelect" hidden></div>
        <div class="preview-panel" id="previewPanel" hidden>
          <img class="preview-thumb" id="previewThumb" alt="" draggable="false">
          <div class="preview-resize-handle" id="previewResizeHandle" title="${t("Изменить размер")}" aria-hidden="true"></div>
        </div>
        <!-- «Назад» — была текстовой ссылкой «← Комната» в .table-toolbar,
             теперь иконка в левом верхнем углу доски (не в .board-tools внизу
             — выход со стола не инструмент сборки). -->
        <div class="board-back">
          <a class="btn outlined icon" href="/room/${encodeURIComponent(roomId)}" title="${t("Комната")}" aria-label="${t("Комната")}">
            <svg class="icon" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>
          </a>
        </div>
        <!-- Кнопки действий стола — всегда иконками (не только на мобильном,
             см. план п.4), в своей плашке в стиле .zoom-controls, но в другом
             углу, чтобы не пересекаться ни с ним, ни с .preview-thumb, ни с
             кнопкой присутствия ниже. -->
        <div class="board-tools">
          <button class="btn outlined icon tools-toggle" id="toolsToggleBtn" type="button" title="${t("Свернуть/развернуть инструменты")}" aria-label="${t("Свернуть/развернуть инструменты")}" aria-expanded="true">
            <svg class="icon" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>
          </button>
          <div class="tools-row" id="toolsRow">
            <button class="btn outlined icon" id="shuffleBtn" type="button" title="${t("Перемешать")}" aria-label="${t("Перемешать")}">
              <svg class="icon" viewBox="0 0 24 24"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>
            </button>
            <button class="btn outlined icon" id="previewBtn" type="button" title="${t("Показать картинку")}" aria-label="${t("Показать картинку")}">
              <svg class="icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
            </button>
            <label class="btn outlined icon" id="boardBgBtn" title="${t("Фон стола — выбрать цвет")}" aria-label="${t("Фон стола — выбрать цвет")}">
              <svg class="icon" viewBox="0 0 24 24"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>
              <input type="color" id="boardBgInput" value="#f8f6ef">
            </label>
            <button class="btn outlined icon" id="boardBgResetBtn" type="button" title="${t("Вернуть фон по умолчанию")}" aria-label="${t("Вернуть фон по умолчанию")}" hidden>
              <svg class="icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
            <!-- На тач-устройствах нет Shift — этот тоггл даёт тот же жест
                 (тянуть рамку по пустому месту вместо панорамы), пока включён,
                 одним пальцем. На десктопе Shift+тяни работает и без него —
                 кнопка просто альтернативный способ включить то же самое. -->
            <button class="btn outlined icon" id="selectModeBtn" type="button" title="${t("Режим выделения")}" aria-label="${t("Режим выделения")}" aria-pressed="false">
              <svg class="icon" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="4 3"/></svg>
            </button>
          </div>
        </div>
        <!-- Подсказка/звук + присутствующие/чат — один сворачиваемый кластер
             верхнего правого угла (см. план «Выдвигающиеся кнопки»): тот же
             паттерн, что .board-tools, но якорем справа — тоггл справа,
             .tools-row раскрывается влево. Чат — намеренно эфемерный (см.
             план «Чат на доску») — ничего не хранится ни на сервере, ни тут,
             история живёт только пока открыта эта вкладка. -->
        <div class="table-widgets">
          <div class="tools-row" id="widgetsRow">
            <button class="btn outlined icon" id="hintBtn" type="button" title="${t("Подсказка")}" aria-label="${t("Подсказка")}">
              <svg class="icon" viewBox="0 0 24 24"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.4 1 1.2 1 2.05V17h6v-2.25c0-.85.4-1.65 1-2.05A7 7 0 0 0 12 2z"/></svg>
            </button>
            <button class="btn outlined icon" id="soundBtn" type="button"></button>
            <div class="chat-widget">
              <button class="btn outlined icon chat-btn" id="chatBtn" type="button"
                title="${t("Чат")}" aria-label="${t("Чат")}" aria-haspopup="true" aria-expanded="false">
                💬<span class="presence-count" id="chatUnread" hidden>0</span>
              </button>
              <div class="chat-popover hidden" id="chatPopover">
                <p class="presence-popover-title">${t("Чат")}</p>
                <div class="chat-messages" id="chatMessages">
                  <p class="state-note">${t("Пока никто ничего не написал.")}</p>
                </div>
                <form class="chat-form" id="chatForm">
                  <input class="text-input" id="chatInput" type="text" maxlength="500" placeholder="${t("Сообщение…")}" autocomplete="off">
                  <button class="btn filled icon sm" type="submit" title="${t("Отправить")}" aria-label="${t("Отправить")}">
                    <svg class="icon" viewBox="0 0 24 24"><path d="M4 12 20 4l-6 16-2-7-8-1z"/></svg>
                  </button>
                </form>
              </div>
            </div>
            <div class="presence-widget">
              <button class="btn outlined icon presence-btn" id="presenceBtn" type="button"
                title="${t("Участники за столом")}" aria-label="${t("Участники за столом")}" aria-haspopup="true" aria-expanded="false">
                👥<span class="presence-count" id="presenceCount" hidden>0</span>
              </button>
              <div class="presence-popover hidden" id="presencePopover">
                <p class="presence-popover-title">${t("За столом")}</p>
                <div class="presence-popover-list" id="presenceList"></div>
              </div>
            </div>
          </div>
          <button class="btn outlined icon tools-toggle" id="widgetsToggleBtn" type="button" title="${t("Свернуть/развернуть инструменты")}" aria-label="${t("Свернуть/развернуть инструменты")}" aria-expanded="true">
            <svg class="icon" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
          </button>
        </div>
        <div class="zoom-controls">
          <button class="btn outlined icon" id="zoomInBtn" type="button" title="${t("Приблизить")}" aria-label="${t("Приблизить")}">+</button>
          <button class="btn outlined icon" id="zoomResetBtn" type="button" title="${t("Показать всё")}" aria-label="${t("Показать всё")}">⤢</button>
          <button class="btn outlined icon" id="zoomOutBtn" type="button" title="${t("Отдалить")}" aria-label="${t("Отдалить")}">−</button>
        </div>
      </div>
    </div>`;
  const stage = $(root, "#stage");
  // Обучение (см. assets/onboarding.js) — кнопка открывает тур заново в
  // любой момент; сам тур один на оба стола (соло/комната), шаги про
  // отсутствующие тут элементы (чат/присутствие) молча пропускаются.
  $(root, "#tableHelpBtn").addEventListener("click", () => openTour(), { signal });

  let session;
  try {
    const [sessionRes] = await Promise.all([
      roomFetch(`/api/rooms/${encodeURIComponent(roomId)}/sessions/${encodeURIComponent(sessionId)}`),
      ensureDisplayTitleCache(),
    ]);
    if (!sessionRes.ok) throw new Error("session fetch failed");
    session = await sessionRes.json();
  } catch {
    if (!signal.aborted) stage.innerHTML = `<p class="state-note">${t("Не удалось открыть стол — обновите страницу.")}</p>`;
    return;
  }
  if (signal.aborted) return;
  // Сеанс уже завершён — сервер отклонит апгрейд сокета 410-м, а браузерный
  // WebSocket не умеет донести код HTTP-отказа до JS (close без вменяемой
  // причины), поэтому клиент раньше уходил в вечный "переподключение…".
  // Проверяем то же поле, что уже пришло в session, до попытки подключения.
  if (session.completedAt) {
    // Не тупик: «мы не вправе ограничивать этим пользователя» — вместо
    // возврата в комнату без вариантов даём стартовать новый сеанс тем же
    // пазлом (см. «Ключевые решения» в плане — старый сеанс остаётся в
    // истории с тем же completedAt, его физически не трогаем).
    stage.innerHTML = `
      <div class="state-note">
        <p>${t("Этот пазл уже собран.")}</p>
        <button class="btn filled sm" id="replayBtn" type="button">${t("Собрать ещё раз")}</button>
        <a class="btn text sm" href="/room/${encodeURIComponent(roomId)}">${t("Вернуться в комнату")}</a>
      </div>`;
    $(stage, "#replayBtn").addEventListener("click", async e => {
      e.target.disabled = true;
      try {
        const newId = await startRoomSession(roomId, session.puzzle.id);
        navigate(`/room/${encodeURIComponent(roomId)}/table/${encodeURIComponent(newId)}`);
      } catch { e.target.disabled = false; }
    }, { signal });
    return;
  }
  const puzzle = session.puzzle;
  $(root, "#tableTitle").textContent = puzzleDisplayTitle(puzzle);
  trackGoal("puzzle_started");

  const rows = puzzle.gridRows, cols = puzzle.gridCols;
  const pad = CELL * PAD_FACTOR;
  const boardW = cols * CELL, boardH = rows * CELL;
  // Форма зафиксирована на СЕАНСЕ (см. server.js, asymmetric_shape) — общая
  // для всех участников комнаты, а не выбор каждого зрителя по отдельности.
  const edges = window.PuzzleShapes.buildEdges(puzzle.seed, rows, cols, { asymmetric: session.asymmetricShape });
  // Повороты — тем же приёмом, что форма выше (см. server.js, rotation_enabled).
  const rotationEnabled = session.rotationEnabled;

  const world = $(root, "#world");
  const progressEl = $(root, "#tableProgress");
  const presenceBtn = $(root, "#presenceBtn");
  const presenceCount = $(root, "#presenceCount");
  const presencePopover = $(root, "#presencePopover");
  const presenceListEl = $(root, "#presenceList");
  function setPresencePopoverOpen(open) {
    presencePopover.classList.toggle("hidden", !open);
    presenceBtn.setAttribute("aria-expanded", String(open));
  }
  presenceBtn.addEventListener("click", e => {
    e.stopPropagation();
    setPresencePopoverOpen(presencePopover.classList.contains("hidden"));
  }, { signal });
  // Клик снаружи закрывает поповер — тот же паттерн, что у модалок
  // (клик по подложке), но без подложки: поповер компактный, не блокирует
  // остальной интерфейс.
  document.addEventListener("click", e => {
    if (presencePopover.classList.contains("hidden")) return;
    if (e.target.closest(".presence-widget")) return;
    setPresencePopoverOpen(false);
  }, { signal });

  // Чат за столом (см. план «Чат на доску») — эфемерный: ничего не пишется
  // ни на сервер (см. server.js, ветка msg.type==="chat" — просто транзит
  // через broadcast), ни сюда в постоянное хранилище — лента живёт только
  // в памяти этой вкладки, при перезаходе начинается с чистого листа.
  const chatWidget = $(root, ".chat-widget");
  const chatBtn = $(root, "#chatBtn");
  const chatUnread = $(root, "#chatUnread");
  const chatPopover = $(root, "#chatPopover");
  const chatMessagesEl = $(root, "#chatMessages");
  const chatForm = $(root, "#chatForm");
  const chatInput = $(root, "#chatInput");
  let unreadCount = 0;
  // Личность самого клиента — приходит один раз в первом sync (см.
  // server.js, attachRoomConnection) и ловится в handleSocketMessage ниже —
  // нужна, чтобы отличать свои сообщения от чужих (см. appendChatMessage).
  let myIdentity = null;
  // Ярлыки участников (Гость/Гость N для анонимов, имя/логин для вошедших)
  // должны совпадать с тем, что показывает поповер «За столом» — держим
  // карту id→ярлык, пересчитываемую при каждом presence-обновлении (см.
  // updatePresence ниже), а не гадаем заново на каждое сообщение: иначе
  // один и тот же гость мог бы получить разные номера в чате и в presence.
  let latestPresenceLabels = new Map();
  function setChatPopoverOpen(open) {
    chatPopover.classList.toggle("hidden", !open);
    chatBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      unreadCount = 0; chatUnread.hidden = true; chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
      // Открыли — значит только что смотрим на него, не притушенный.
      chatWidget.classList.remove("chat-unfocused");
    }
  }
  chatBtn.addEventListener("click", e => {
    e.stopPropagation();
    setChatPopoverOpen(chatPopover.classList.contains("hidden"));
  }, { signal });
  // Клик снаружи, пока чат открыт, — НЕ закрывает панель (см. план «Чат —
  // притушить, а не прятать»), просто притушивает: убрать её совсем можно
  // только повторным нажатием на саму кнопку чата (см. обработчик выше).
  // Клик/наведение внутри (или на саму кнопку) возвращают полную яркость —
  // .chat-unfocused снимается тут же, при первом же клике внутри виджета.
  document.addEventListener("click", e => {
    if (chatPopover.classList.contains("hidden")) return;
    chatWidget.classList.toggle("chat-unfocused", !e.target.closest(".chat-widget"));
  }, { signal });
  function appendChatMessage(msg) {
    const empty = chatMessagesEl.querySelector(".state-note");
    if (empty) empty.remove();
    const label = latestPresenceLabels.get(msg.from.id) || roomMemberLabels([msg.from], "id")[0];
    const mine = myIdentity && msg.from.id === myIdentity.id;
    const row = document.createElement("div");
    row.className = "chat-message " + (mine ? "own" : "other");
    const meta = document.createElement("div");
    meta.className = "meta";
    // Своё сообщение и так узнаётся по стороне/цвету — имя над ним только
    // шумело бы (тот же принцип, что в любом мессенджере: подпись отправителя
    // нужна лишь у чужих сообщений).
    if (!mine) {
      const sender = document.createElement("span");
      sender.className = "sender";
      sender.textContent = label;
      meta.appendChild(sender);
    }
    const at = document.createElement("span");
    at.className = "at";
    at.textContent = new Date(msg.at).toLocaleTimeString(getLang() === "en" ? "en-US" : "ru-RU", { hour: "2-digit", minute: "2-digit" });
    meta.appendChild(at);
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = msg.text;
    row.append(meta, bubble);
    chatMessagesEl.appendChild(row);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    if (chatPopover.classList.contains("hidden")) {
      unreadCount++;
      chatUnread.textContent = String(unreadCount);
      chatUnread.hidden = false;
    }
  }
  chatForm.addEventListener("submit", e => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    socket.send({ type: "chat", text });
    chatInput.value = "";
  }, { signal });

  const scatter = scatterLayout(rows, cols, CELL, pad);
  const BOARD_X = scatter.margin, BOARD_Y = scatter.margin;

  world.style.width = scatter.worldW + "px";
  world.style.height = scatter.worldH + "px";

  const outline = document.createElement("div");
  outline.className = "board-outline";
  outline.style.left = BOARD_X + "px";
  outline.style.top = BOARD_Y + "px";
  outline.style.width = boardW + "px";
  outline.style.height = boardH + "px";
  world.appendChild(outline);

  /* ── zoom/pan мирового контейнера — идентично renderTable ── */
  let zoom = 1, panX = 0, panY = 0;
  const ZOOM_MIN = 0.12, ZOOM_MAX = 3.2;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function applyWorldTransform() { world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`; }
  // fitBox — общая математика вписывания прямоугольника мировых координат в
  // stage (см. план «Повороты...» — подсказка вписывает только пару целевых
  // деталей, не весь стол). marginFactor меньше 1 — свободные поля вокруг
  // (0.94 — почти впритык, как раньше у fitView; у подсказки поля пошире,
  // чтобы обе детали не упирались в края экрана).
  function fitBox(x0, y0, x1, y1, marginFactor = 0.94) {
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    const scale = Math.min(rect.width / w, rect.height / h) * marginFactor;
    zoom = clamp(scale, ZOOM_MIN, ZOOM_MAX);
    panX = rect.width / 2 - ((x0 + x1) / 2) * zoom;
    panY = rect.height / 2 - ((y0 + y1) / 2) * zoom;
    applyWorldTransform();
  }
  function fitView() { fitBox(0, 0, scatter.worldW, scatter.worldH); }
  function zoomAt(clientX, clientY, factor) {
    const rect = stage.getBoundingClientRect();
    const cx = clientX - rect.left, cy = clientY - rect.top;
    const wx = (cx - panX) / zoom, wy = (cy - panY) / zoom;
    zoom = clamp(zoom * factor, ZOOM_MIN, ZOOM_MAX);
    panX = cx - wx * zoom;
    panY = cy - wy * zoom;
    applyWorldTransform();
  }
  fitView();

  /* ── авто-панорама к краю доски во время драга детали — см. подробный
     комментарий в renderTable, механика идентична. Тут дополнительно на
     каждый тик (не только на реальный pointermove) шлём move/group —
     иначе для остальных участников деталь «телепортировалась» бы только
     в момент отпускания, а не ехала бы плавно вместе с автоскроллом. ── */
  const EDGE_MARGIN = 56, EDGE_MAX_SPEED = 16;
  function screenToWorld(clientX, clientY) {
    const r = stage.getBoundingClientRect();
    return { x: (clientX - r.left - panX) / zoom, y: (clientY - r.top - panY) / zoom };
  }
  let activeDrag = null;
  function applyActiveDragPositions() {
    const w = screenToWorld(activeDrag.lastClientX, activeDrag.lastClientY);
    for (const [k, ox, oy] of activeDrag.offsets) {
      const p = pieces.get(k);
      p.x = w.x + ox; p.y = w.y + oy;
      applyPieceTransform(p);
    }
    if (activeDrag.offsets.length > 1) activeDrag.sendGroup(activeDrag.draggingKeys);
    else activeDrag.sendMove(activeDrag.piece);
  }
  let edgePanRAF = null;
  function edgePanTick() {
    if (!activeDrag) { edgePanRAF = null; return; }
    const r = stage.getBoundingClientRect();
    const x = activeDrag.lastClientX - r.left, y = activeDrag.lastClientY - r.top;
    const push = (pos, size) => pos < EDGE_MARGIN ? clamp(1 - pos / EDGE_MARGIN, 0, 1)
      : pos > size - EDGE_MARGIN ? -clamp(1 - (size - pos) / EDGE_MARGIN, 0, 1) : 0;
    const vx = push(x, r.width) * EDGE_MAX_SPEED, vy = push(y, r.height) * EDGE_MAX_SPEED;
    if (vx || vy) {
      panX += vx; panY += vy;
      applyWorldTransform();
      applyActiveDragPositions();
    }
    edgePanRAF = requestAnimationFrame(edgePanTick);
  }
  signal.addEventListener("abort", () => {
    activeDrag = null;
    if (edgePanRAF !== null) { cancelAnimationFrame(edgePanRAF); edgePanRAF = null; }
  });

  stage.addEventListener("wheel", e => {
    e.preventDefault();
    const factor = Math.pow(1.0016, -e.deltaY);
    zoomAt(e.clientX, e.clientY, factor);
  }, { passive: false, signal });

  const active = new Map();
  let panState = null, pinchState = null, clickCandidate = null;
  const midOf = m => { const p = [...m.values()]; return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }; };
  const distOf = m => { const p = [...m.values()]; return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); };

  /* ── массовое выделение рамкой (Shift+тяни по пустому месту доски, или
     тоггл #selectModeBtn для тач) — см. подробный комментарий в
     renderTable, механика идентична. ── */
  let selectMode = false;
  let marqueeState = null; // { pointerId, startX, startY, baseSelected }
  const marqueeEl = $(root, "#marqueeSelect");
  function updateMarqueeRect(x0, y0, x1, y1) {
    const r = stage.getBoundingClientRect();
    marqueeEl.style.left = `${Math.min(x0, x1) - r.left}px`;
    marqueeEl.style.top = `${Math.min(y0, y1) - r.top}px`;
    marqueeEl.style.width = `${Math.abs(x1 - x0)}px`;
    marqueeEl.style.height = `${Math.abs(y1 - y0)}px`;
  }
  function updateMarqueeSelection(x0, y0, x1, y1) {
    const w0 = screenToWorld(Math.min(x0, x1), Math.min(y0, y1));
    const w1 = screenToWorld(Math.max(x0, x1), Math.max(y0, y1));
    const size = CELL + 2 * pad; // полный размер SVG детали (с запасом под выступы), см. createPieceEl
    const next = new Set(marqueeState.baseSelected);
    for (const [k, p] of pieces) {
      if (p.x < w1.x && p.x + size > w0.x && p.y < w1.y && p.y + size > w0.y) next.add(k);
    }
    setSelected(next);
  }

  stage.addEventListener("pointerdown", e => {
    // .zoom-controls (а теперь и .board-tools/.board-back/.win-overlay/
    // .table-give-up) тоже исключаем: иначе setPointerCapture ниже
    // перехватывает указатель на #stage раньше, чем браузер успевает
    // синтезировать click на кнопке — колесо мыши работало (свой отдельный
    // wheel-хендлер), а кнопки +/−/⤢ (и, отдельно найденный тот же баг,
    // кнопки в окне победы) не реагировали на клик вовсе. .table-widgets —
    // presence и чат разом (см. renderRoomTable) — иначе клик/скролл внутри
    // поповера чата пытался запустить панораму доски под ним.
    if (e.target.closest(".piece") || e.target.closest(".zoom-controls") || e.target.closest(".board-tools")
      || e.target.closest(".board-back") || e.target.closest(".table-widgets") || e.target.closest(".preview-panel")
      || e.target.closest(".win-overlay") || e.target.closest(".table-give-up")) return;
    stage.setPointerCapture(e.pointerId);
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (active.size === 1) {
      if (e.shiftKey || selectMode) {
        marqueeState = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, baseSelected: new Set(selected) };
        marqueeEl.hidden = false;
        updateMarqueeRect(e.clientX, e.clientY, e.clientX, e.clientY);
        clickCandidate = null;
      } else {
        panState = { startX: e.clientX, startY: e.clientY, originX: panX, originY: panY };
        stage.classList.add("panning");
        clickCandidate = { x: e.clientX, y: e.clientY };
      }
    } else if (active.size === 2) {
      panState = null;
      marqueeState = null;
      marqueeEl.hidden = true;
      pinchState = { lastDist: distOf(active), lastMid: midOf(active) };
      clickCandidate = null;
    }
  }, { signal });

  stage.addEventListener("pointermove", e => {
    if (clickCandidate && Math.hypot(e.clientX - clickCandidate.x, e.clientY - clickCandidate.y) > 4) clickCandidate = null;
    if (!active.has(e.pointerId)) return;
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (marqueeState && e.pointerId === marqueeState.pointerId) {
      updateMarqueeRect(marqueeState.startX, marqueeState.startY, e.clientX, e.clientY);
      updateMarqueeSelection(marqueeState.startX, marqueeState.startY, e.clientX, e.clientY);
      return;
    }
    if (active.size === 2) {
      const mid = midOf(active), dist = distOf(active);
      if (pinchState) {
        const rect = stage.getBoundingClientRect();
        const oldCx = pinchState.lastMid.x - rect.left, oldCy = pinchState.lastMid.y - rect.top;
        const wx = (oldCx - panX) / zoom, wy = (oldCy - panY) / zoom;
        zoom = clamp(zoom * (dist / pinchState.lastDist), ZOOM_MIN, ZOOM_MAX);
        const newCx = mid.x - rect.left, newCy = mid.y - rect.top;
        panX = newCx - wx * zoom;
        panY = newCy - wy * zoom;
        applyWorldTransform();
      }
      pinchState = { lastDist: dist, lastMid: mid };
    } else if (active.size === 1 && panState) {
      panX = panState.originX + (e.clientX - panState.startX);
      panY = panState.originY + (e.clientY - panState.startY);
      applyWorldTransform();
    }
  }, { signal });

  function endPointer(e) {
    active.delete(e.pointerId);
    if (marqueeState && e.pointerId === marqueeState.pointerId) {
      marqueeState = null;
      marqueeEl.hidden = true;
      clickCandidate = null;
      return;
    }
    if (active.size === 1) {
      const [, p] = [...active.entries()][0];
      panState = { startX: p.x, startY: p.y, originX: panX, originY: panY };
      pinchState = null;
    } else if (active.size === 0) {
      panState = null; pinchState = null;
      stage.classList.remove("panning");
    }
    if (clickCandidate && selected.size) setSelected([]);
    clickCandidate = null;
  }
  stage.addEventListener("pointerup", endPointer, { signal });
  stage.addEventListener("pointercancel", endPointer, { signal });

  $(root, "#zoomInBtn").addEventListener("click", () => {
    const r = stage.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25);
  }, { signal });
  $(root, "#zoomOutBtn").addEventListener("click", () => {
    const r = stage.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.8);
  }, { signal });
  $(root, "#zoomResetBtn").addEventListener("click", fitView, { signal });
  window.addEventListener("resize", fitView, { signal });

  bindPreviewThumb(stage, $(root, "#previewPanel"), $(root, "#previewThumb"), $(root, "#previewResizeHandle"), $(root, "#previewBtn"), puzzle.imageUrl, puzzleDisplayTitle(puzzle), signal);

  bindBoardBackground(stage, $(root, "#boardBgInput"), $(root, "#boardBgResetBtn"), signal);

  // Тач-замена Shift для рамки выделения — см. комментарий у marqueeState
  // выше. На десктопе не нужна (там уже работает Shift+тяни), но не мешает
  // ей — оба способа включают одно и то же условие в pointerdown.
  $(root, "#selectModeBtn").addEventListener("click", e => {
    selectMode = !selectMode;
    e.currentTarget.setAttribute("aria-pressed", String(selectMode));
  }, { signal });

  $(root, "#shuffleBtn").addEventListener("click", () => {
    // pieces строится асинхронно в buildBoard() по первому sync — до этого
    // момента стол ещё не собран, перемешивать нечего.
    if (!pieces) return;
    // Та же поправка, что и в соло: любая уже состыкованная пара/кластер не
    // трогается — переставляются только ещё не соединённые одиночки. Риска
    // потерять прогресс нет, confirm не нужен.
    const next = planShuffle(pieces, rows, cols, CELL, pad, SNAP_TOLERANCE, BOARD_X, BOARD_Y);
    if (!next) return;
    // Шлём только реально переставленные детали (ключи next), а не весь
    // борд — см. разбор гонки group/shuffle в server.js: полный снимок
    // ЛОКАЛЬНОГО pieces отправителя мог быть устаревшим для деталей, которых
    // «Перемешать» не касалось (их мог только что подвинуть кто-то другой),
    // и слепая замена state.pieces целиком откатывала бы этот чужой ход.
    const arr = [...next.entries()].map(([k, pos]) => {
      const piece = pieces.get(k);
      // rot — сохраняем ТЕКУЩИЙ поворот детали (см. план «Повороты
      // деталей»): «Перемешать» двигает только x/y, без этого поля
      // sanitizePieceItem на сервере молча подставил бы 0 и откатил бы
      // повёрнутую-но-ещё-не-состыкованную деталь обратно вертикально.
      return { r: piece.r, c: piece.c, x: pos.x, y: pos.y, rot: piece.rot || 0, placed: false };
    });
    socket.send({ type: "shuffle", pieces: arr });
  }, { signal });

  // Подсказка + звук — см. солo-версию выше, тот же приём.
  $(root, "#hintBtn").addEventListener("click", () => {
    if (!pieces) return;
    const pair = pickHintPair(pieces);
    if (!pair) return;
    const [a, b] = pair;
    const size = CELL + 2 * pad;
    fitBox(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x) + size, Math.max(a.y, b.y) + size, 0.5);
    for (const p of [a, b]) {
      p.el.classList.add("hint-glow");
      setTimeout(() => p.el.classList.remove("hint-glow"), 3000);
    }
  }, { signal });
  bindSoundButton($(root, "#soundBtn"), signal);
  bindCollapsibleCluster($(root, "#toolsToggleBtn"), $(root, "#toolsRow"), "puzzle_tools_collapsed", signal);
  bindCollapsibleCluster($(root, "#widgetsToggleBtn"), $(root, "#widgetsRow"), "puzzle_widgets_collapsed", signal);

  function updateProgressLabel(placed, total) {
    progressEl.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = `${placed}/${total}`;
    progressEl.append(b, document.createTextNode(getLang() === "en" ? " pieces placed" : " деталей собрано"));
  }
  function updatePresence(members) {
    const list = members || [];
    presenceCount.textContent = String(list.length);
    presenceCount.hidden = list.length === 0;
    presenceListEl.innerHTML = "";
    const labels = roomMemberLabels(list, "id");
    // Та же карта переиспользуется чатом (см. appendChatMessage выше) —
    // ярлыки гостей должны совпадать в обеих панелях.
    latestPresenceLabels = new Map(list.map((m, i) => [m.id, labels[i]]));
    list.forEach((m, i) => {
      const chip = document.createElement("span");
      chip.className = "presence-chip";
      chip.textContent = labels[i];
      presenceListEl.appendChild(chip);
    });
  }
  function showWin() {
    trackGoal("puzzle_completed");
    const overlay = document.createElement("div");
    overlay.className = "win-overlay";
    const card = document.createElement("div");
    card.className = "win-card";
    const img = document.createElement("img");
    img.className = "win-image"; img.src = puzzle.imageUrl; img.alt = puzzleDisplayTitle(puzzle);
    const h2 = document.createElement("h2"); h2.textContent = t("Готово!");
    const displayTitle = puzzleDisplayTitle(puzzle);
    const p = document.createElement("p"); p.textContent = getLang() === "en" ? `Puzzle "${displayTitle}" is complete — solved together with friends.` : `Пазл «${displayTitle}» собран вместе с друзьями.`;
    // session.startedAt — момент старта ЭТОГО сеанса (см. sessionSummary в
    // server.js, уже отдаётся с самого начала) — в отличие от соло, тут не
    // нужно ничего досчитывать самим: комнатный сеанс общий на всех
    // участников, отдельного "моего" старта тут просто нет.
    const stats = buildStatsBlock(session.startedAt, Date.now(), puzzle.gridRows * puzzle.gridCols);
    const rating = buildRatingWidget(puzzle, signal);
    const actions = document.createElement("div");
    actions.className = "win-actions";
    // В комнате пазл может оказаться и чужим/своим НЕопубликованным фото
    // (ownerUserId не null) — публичной страницы пазла у него ещё нет
    // (см. server.js, api() GET /api/puzzles/:id отдаёт 404 не-автору),
    // кнопку в этом случае просто не показываем, а не ведём на 404.
    if (!puzzle.ownerUserId) {
      const shareBtn = document.createElement("button");
      shareBtn.className = "btn outlined icon"; shareBtn.type = "button";
      shareBtn.title = t("Скопировать ссылку на пазл"); shareBtn.setAttribute("aria-label", shareBtn.title);
      shareBtn.innerHTML = SHARE_ICON;
      // /puzzle/:id, не /table/:id (см. план «Страница пазла вместо
      // превью-модалки»).
      bindShareButton(shareBtn, () => `${location.origin}/puzzle/${encodeURIComponent(puzzle.id)}`);
      actions.appendChild(shareBtn);
    }
    const stayBtn = document.createElement("button");
    stayBtn.className = "btn outlined"; stayBtn.type = "button"; stayBtn.textContent = t("Остаться");
    stayBtn.addEventListener("click", () => overlay.remove());
    const homeBtn = document.createElement("button");
    homeBtn.className = "btn filled"; homeBtn.type = "button"; homeBtn.textContent = t("В комнату");
    homeBtn.addEventListener("click", () => { navigate(`/room/${encodeURIComponent(roomId)}`); });
    actions.append(stayBtn, homeBtn);
    card.append(img, h2, p, stats, rating, actions);
    overlay.appendChild(card);
    stage.appendChild(overlay);
    launchConfetti(overlay);
    playWinSound();
  }

  /* ── перетаскивание детали: локально сразу, серверу — троттлингом ── */
  const draggingKeys = new Set(); // детали, которые СЕЙЧАС тащит локальный пользователь — resync их не трогает
  let pieces; // Map "r,c" -> piece, строится в buildBoard() по первому sync
  let announced = false; // защита от повторного showWin() при нескольких sync подряд (троттлинг group)
  let lastClusterEdgeIds = new Set(); // "r,c|r,c" — вспышка только на НОВЫХ стыковках (свой драг и чужой sync)

  const selected = new Set(); // ключи "r,c" — текущее ручное выделение (клик/shift-клик)
  function setSelected(keys) {
    selected.clear();
    for (const k of keys) selected.add(k);
    for (const [k, p] of pieces) p.el.classList.toggle("selected", selected.has(k));
  }

  /* activeDrag — общее (не per-piece) состояние, см. блок авто-панорамы
     выше: rAF-тику edgePanTick нужно знать о текущем драге независимо от
     того, какая именно деталь его начала. Не путать с draggingKeys —
     тот отдельный набор живёт снаружи (см. выше) и защищает от resync
     поверх ещё не подтверждённого сервером локального хода. */
  function bindRoomPieceDrag(el, piece, sendMove, sendGroup) {
    let moved = false;
    const key = `${piece.r},${piece.c}`;

    el.addEventListener("pointerdown", e => {
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      moved = false;
      // Клик по детали выделяет весь уже собранный сегмент, в который она
      // входит (не только саму деталь) — тащить всё равно будет весь
      // кластер целиком (groupSet ниже строится тем же buildClusters),
      // выделение теперь отражает это сразу, а не только во время драга.
      const { clusterOf, members } = window.PuzzleClusters.buildClusters(pieces.values(), CELL, SNAP_TOLERANCE);
      if (!(selected.has(key) && selected.size > 1)) setSelected(members.get(clusterOf.get(key)));
      const groupSet = new Set();
      for (const k of selected) for (const m of members.get(clusterOf.get(k))) groupSet.add(m);
      // Смещение каждой детали от мировой точки под курсором в момент
      // начала драга (не от абсолютной позиции детали) — так деталь
      // остаётся под курсором даже если panX/panY поменяются во время
      // драга без единого pointermove (см. edgePanTick).
      const w0 = screenToWorld(e.clientX, e.clientY);
      const offsets = [...groupSet].map(k => {
        const p = pieces.get(k);
        p.el.classList.add("dragging");
        draggingKeys.add(k);
        return [k, p.x - w0.x, p.y - w0.y];
      });
      activeDrag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, offsets, draggingKeys: groupSet, lastClientX: e.clientX, lastClientY: e.clientY, piece, sendMove, sendGroup };
      if (edgePanRAF === null) edgePanRAF = requestAnimationFrame(edgePanTick);
    }, { signal });

    el.addEventListener("pointermove", e => {
      if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
      const dx0 = e.clientX - activeDrag.startX, dy0 = e.clientY - activeDrag.startY;
      if (!moved && Math.hypot(dx0, dy0) > 4) moved = true;
      activeDrag.lastClientX = e.clientX; activeDrag.lastClientY = e.clientY;
      applyActiveDragPositions();
    }, { signal });

    function finish(e) {
      if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
      const { offsets, draggingKeys: groupKeys } = activeDrag;
      activeDrag = null;
      // См. комментарий у аналогичной строки в renderTable/bindPieceDrag —
      // отменяем ещё не сработавший кадр авто-панорамы явно.
      if (edgePanRAF !== null) { cancelAnimationFrame(edgePanRAF); edgePanRAF = null; }
      for (const [k] of offsets) pieces.get(k).el.classList.remove("dragging");
      if (!moved) {
        for (const [k] of offsets) draggingKeys.delete(k);
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        if (additive) {
          const next = new Set(selected);
          if (next.has(key)) next.delete(key); else next.add(key);
          setSelected(next);
        } else {
          setSelected(clusterMembersOf(pieces, key));
        }
        return;
      }
      window.PuzzleClusters.stitchGroup(pieces, groupKeys, CELL, SNAP_TOLERANCE);
      for (const k of groupKeys) { applyPieceTransform(pieces.get(k)); draggingKeys.delete(k); }
      const { members, edges } = window.PuzzleClusters.buildClusters(pieces.values(), CELL, SNAP_TOLERANCE);
      const { nextIds, newCount } = flashClusterEdges(pieces, lastClusterEdgeIds, edges);
      lastClusterEdgeIds = nextIds;
      if (newCount > 0) playConnectSound();
      updateProgressLabel(window.PuzzleClusters.connectedPiecesCount(members), rows * cols);
      setSelected([]);
      // >1 детали тащили или стыковка образовала новое ребро — шлём группой
      // ТОЛЬКО те детали, которых коснулся этот жест (groupKeys — тащенная
      // группа, включая стыковку соседей внутри неё; сами соседи, к которым
      // пристыковались, не входят в groupKeys и не пересылаются — их
      // координаты не менялись), иначе — компактный move одной детали. Не
      // весь борд: см. разбор гонки group/shuffle в server.js.
      if (offsets.length > 1 || newCount > 0) sendGroup(groupKeys);
      else sendMove(piece);
    }
    el.addEventListener("pointerup", finish, { signal });
    el.addEventListener("pointercancel", finish, { signal });
    // Подстраховка от «вечно тащим» (см. расследование бага с прогрессом):
    // pointerup/pointercancel не гарантированно долетают при нештатном
    // завершении жеста (потеря фокуса окна, вкладка свёрнута, ОС перехватила
    // жест) — lostpointercapture по спецификации срабатывает ВСЕГДА, когда
    // элемент теряет захват указателя, каким бы ни был повод, поэтому это
    // надёжная точка для финального finish() и очистки draggingKeys/activeDrag.
    el.addEventListener("lostpointercapture", finish, { signal });
    // Поворот — двойной клик/тап, см. аналогичный обработчик в renderTable/
    // bindPieceDrag. Только у одиночной детали (кластер >1 уже rot===0).
    el.addEventListener("dblclick", () => {
      if (clusterMembersOf(pieces, key).size > 1) return;
      piece.rot = ((piece.rot || 0) + 90) % 360;
      window.PuzzleClusters.stitchGroup(pieces, new Set([key]), CELL, SNAP_TOLERANCE);
      applyPieceTransform(piece);
      const { members, edges } = window.PuzzleClusters.buildClusters(pieces.values(), CELL, SNAP_TOLERANCE);
      const { nextIds, newCount } = flashClusterEdges(pieces, lastClusterEdgeIds, edges);
      lastClusterEdgeIds = nextIds;
      if (newCount > 0) playConnectSound();
      updateProgressLabel(window.PuzzleClusters.connectedPiecesCount(members), rows * cols);
      sendGroup(new Set([key]));
    }, { signal });
  }

  function reconcilePiece(r, c, x, y, rot) {
    const key = `${r},${c}`;
    if (draggingKeys.has(key)) return;
    const piece = pieces.get(key);
    if (!piece) return;
    piece.x = x; piece.y = y;
    if (rot !== undefined) piece.rot = rot;
    applyPieceTransform(piece);
  }

  function buildBoard(initialPieces) {
    pieces = new Map();
    let scatterIdx = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const known = initialPieces && initialPieces.find(p => p.r === r && p.c === c);
        let x, y, rot;
        if (known) { x = known.x; y = known.y; rot = known.rot || 0; }
        else {
          const cell = scatter.cells[scatterIdx++]; x = cell.x; y = cell.y;
          rot = rotationEnabled ? [0, 90, 180, 270][Math.floor(Math.random() * 4)] : 0;
        }
        pieces.set(`${r},${c}`, { r, c, x, y, rot });
      }
    }

    const sendMove = throttle(p => socket.send({ type: "move", r: p.r, c: p.c, x: p.x, y: p.y, rot: p.rot || 0 }), 70);
    // keys — только детали ЭТОГО жеста (см. bindRoomPieceDrag), не весь
    // борд: сервер мержит group/shuffle по ключу поверх своего состояния
    // (см. server.js), полный локальный снимок отправителя мог быть
    // устаревшим для деталей, которых этот жест не касался, и раньше слепо
    // затирал чужой параллельный ход (гонка при одновременном перетаскивании
    // разными участниками — регресс test/e2e-rooms.mjs).
    const sendGroup = throttle(keys => {
      const arr = [...keys].map(k => { const p = pieces.get(k); return { r: p.r, c: p.c, x: p.x, y: p.y, rot: p.rot || 0, placed: false }; });
      socket.send({ type: "group", pieces: arr });
    }, 70);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const piece = pieces.get(`${r},${c}`);
        const el = createPieceEl(puzzle.id, r, c, rows, cols, CELL, pad, edges, puzzle.imageUrl, boardW, boardH);
        piece.el = el;
        applyPieceTransform(piece);
        world.appendChild(el);
        bindRoomPieceDrag(el, piece, sendMove, sendGroup);
      }
    }
    const built = window.PuzzleClusters.buildClusters(pieces.values(), CELL, SNAP_TOLERANCE);
    lastClusterEdgeIds = clusterEdgeIds(built.edges);
    updateProgressLabel(window.PuzzleClusters.connectedPiecesCount(built.members), rows * cols);

    // Раскладку никто не задал — эту раскладку и предлагаем как каноническую
    // (см. план: "первый валидный init побеждает", гонка самоисцеляется).
    if (!initialPieces) {
      socket.send({ type: "init", pieces: [...pieces.values()].map(p => ({ r: p.r, c: p.c, x: p.x, y: p.y, rot: p.rot || 0, placed: false })) });
    }
  }

  function handleSocketMessage(msg) {
    // Личная информация о себе — приходит только в самом первом sync (см.
    // server.js, attachRoomConnection) — нужна чату, чтобы отличать свои
    // сообщения от чужих (см. appendChatMessage ниже).
    if (msg.you) myIdentity = msg.you;
    if (msg.type === "sync") {
      if (!pieces) return void buildBoard(msg.pieces);
      if (msg.pieces) for (const p of msg.pieces) reconcilePiece(p.r, p.c, p.x, p.y, p.rot);
      // Кластеры/вспышка/прогресс пересчитываются здесь целиком — это ловит
      // и стыковку своим драгом (эхо своего же group/shuffle), и стыковку
      // чужим драгом (пришедшую только через sync), одним и тем же путём.
      const built = window.PuzzleClusters.buildClusters(pieces.values(), CELL, SNAP_TOLERANCE);
      const { nextIds } = flashClusterEdges(pieces, lastClusterEdgeIds, built.edges);
      lastClusterEdgeIds = nextIds;
      const placedNow = window.PuzzleClusters.connectedPiecesCount(built.members);
      updateProgressLabel(placedNow, msg.piecesTotal);
      updatePresence(msg.members);
      // "Собрано" (placedNow, счётчик выше) и "решено целиком" — разные
      // вещи (см. комментарий у computePiecesPlaced/isPuzzleSolved) —
      // победу показываем только когда все детали — один кластер.
      const largest = window.PuzzleClusters.largestClusterSize(built.members);
      if (largest >= msg.piecesTotal && !announced) { announced = true; showWin(); }
      return;
    }
    if (msg.type === "presence") return updatePresence(msg.members);
    if (msg.type === "chat") return appendChatMessage(msg);
    if (msg.type === "move") return reconcilePiece(msg.r, msg.c, msg.x, msg.y);
  }

  const socket = connectRoomSocket({
    roomId, sessionId, signal,
    onMessage: handleSocketMessage,
    onOpen: () => { progressEl.classList.remove("offline"); },
    onClose: () => { progressEl.classList.add("offline"); },
    onGiveUp: () => {
      progressEl.classList.remove("offline");
      stage.insertAdjacentHTML("beforeend", getLang() === "en"
        ? `<p class="state-note table-give-up">Couldn't connect to the table. <a class="btn text sm" href="/room/${encodeURIComponent(roomId)}">${t("Вернуться в комнату")}</a> or refresh the page.</p>`
        : `<p class="state-note table-give-up">Не удаётся подключиться к столу. <a class="btn text sm" href="/room/${encodeURIComponent(roomId)}">${t("Вернуться в комнату")}</a> или обновите страницу.</p>`);
    },
  });
}

/* ───────────────────────── Яндекс.Метрика: переходы внутри SPA ─────────────────────────
 * Счётчик считает автоматически только самый первый заход (обычная загрузка
 * страницы) — переходы между комнатами/столом идут через History API без
 * перезагрузки (см. план «Прямые ссылки вместо #/»), поэтому на каждую
 * смену пути шлём hit вручную, тем же приёмом, что и в Brain (assets/app.js).
 * document.title по большинству маршрутов не меняется (везде статичный
 * «Что собираем? — BurningHouse», см. index.html) — так их различает сам
 * url (location.href). Исключение — /categories и /category/:slug, там
 * title меняется (см. renderCategories/renderCategoryPage), для лучшего
 * SEO-сигнала эти два маршрута тоже стоило разделить в самой Метрике. */
const METRIKA_ID = 112035178;
function trackPageview() {
  if (typeof ym === "function") ym(METRIKA_ID, "hit", location.href, { title: document.title, referer: document.referrer });
}

/** JS-цели Метрики (см. правку «Метрики для теста в Директе») — до этой
 *  правки счётчик слал только хиты по переходам, никаких целей, поэтому
 *  нельзя было спросить «что делали именно те, кто пришёл из рекламы» —
 *  только «сколько их было». reachGoal сам заводит цель в отчётах при
 *  первом срабатывании (JS-событие) — оформить её полноценной именованной
 *  целью в интерфейсе Метрики можно отдельно, необязательно, здесь только
 *  код. Пять точек: puzzle_started/puzzle_completed (renderTable/
 *  renderRoomTable — showWin), room_created (createRoomBtn), photo_submitted
 *  (заявка на публикацию — само одобрение проходит уже в Admin, откуда
 *  клиент не видит момент), signed_in (init — именно возврат с /authorize,
 *  не каждая загрузка уже вошедшего). */
function trackGoal(name) {
  if (typeof ym === "function") ym(METRIKA_ID, "reachGoal", name);
}

/* ───────────────────────── роутер ─────────────────────────
 * История переходов — pushState/popstate (см. план «Прямые ссылки вместо
 * #/ + страница категорий»), не hashchange: обычные пути индексируются
 * поисковиками, фрагмент после # — нет. navigate() — единственная точка,
 * которая меняет URL и перерисовывает; popstate (кнопки «назад»/«вперёд»)
 * зовёт route() напрямую, без pushState — история уже сдвинута браузером. */
function navigate(path) {
  history.pushState(null, "", path);
  route();
  trackPageview();
}
window.addEventListener("popstate", () => { route(); trackPageview(); });

// Перехват кликов по внутренним ссылкам — без этого обычный <a href="/...">
// даёт полную перезагрузку страницы (регресс: WS переподключается заново,
// теряется мгновенность SPA). Пропускает клики с модификаторами (новая
// вкладка/окно — стандартное поведение браузера не должно ломаться),
// внешние ссылки и ссылки с target/download.
document.addEventListener("click", e => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest("a[href]");
  if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return;
  e.preventDefault();
  navigate(url.pathname + url.search);
});

function route() {
  const pathname = location.pathname;
  const tableMatch = pathname.match(/^\/table\/([^/]+)$/);
  const roomTableMatch = pathname.match(/^\/room\/([^/]+)\/table\/([^/]+)$/);
  const roomJoinMatch = pathname.match(/^\/rooms\/join\/([^/]+)$/);
  const roomMatch = pathname.match(/^\/room\/([^/]+)$/);
  const profileMatch = pathname.match(/^\/profile\/([^/]+)$/);
  const categoryMatch = pathname.match(/^\/category\/([^/]+)$/);
  const puzzleMatch = pathname.match(/^\/puzzle\/([^/]+)$/);
  const root = document.getElementById("app");

  if (currentRouteAbort) currentRouteAbort.abort();
  currentRouteAbort = new AbortController();
  const signal = currentRouteAbort.signal;

  // Сброс title/description перед КАЖДЫМ переходом — без этого вкладка
  // сохраняла бы заголовок категории после клиентского перехода, скажем,
  // на /room/... Сами renderCategories/renderCategoryPage переопределяют
  // это после загрузки своих данных (см. setPageMeta там).
  setPageMeta(DEFAULT_TITLE, DEFAULT_DESCRIPTION);

  const run = roomTableMatch
    ? renderRoomTable(root, decodeURIComponent(roomTableMatch[1]), decodeURIComponent(roomTableMatch[2]), signal)
    : roomJoinMatch ? renderRoomJoin(root, decodeURIComponent(roomJoinMatch[1]), signal)
    : roomMatch ? renderRoom(root, decodeURIComponent(roomMatch[1]), signal)
    : pathname === "/rooms" ? renderRoomsList(root, signal)
    : tableMatch ? renderTable(root, decodeURIComponent(tableMatch[1]), signal, location.search)
    : profileMatch ? renderProfile(root, decodeURIComponent(profileMatch[1]), signal)
    : pathname === "/categories" ? renderCategories(root, signal)
    : categoryMatch ? renderCategoryPage(root, decodeURIComponent(categoryMatch[1]), signal)
    : puzzleMatch ? renderPuzzlePage(root, decodeURIComponent(puzzleMatch[1]), signal)
    : renderLibrary(root, signal);
  run.catch(e => {
    if (signal.aborted) return;
    console.error(e);
    root.innerHTML = `<p class="state-note">${t("Что-то пошло не так — обновите страницу.")}</p>`;
  });
}

/* ───────────────────────── старт ───────────────────────── */
async function init() {
  const cfg = await (await fetch("/api/config")).json();
  // redirectUri — ЯВНО корень, не дефолт auth-client.js (location.origin +
  // location.pathname): с прямыми путями пользователь может открыть вход
  // прямо с /category/... или /room/..., и дефолт увёл бы на редирект,
  // которого нет в Auth (там зарегистрирован только корень, см.
  // client-add). Возврат на исходную страницу после входа — ниже,
  // через sessionStorage (auth.login обёрнут после создания клиента).
  auth = createAuthClient({ authBase: cfg.authBase, clientId: cfg.clientId, storagePrefix: "bh_puzzle", redirectUri: location.origin + "/" });
  const originalLogin = auth.login;
  auth.login = (...args) => {
    sessionStorage.setItem("puzzle_return_to", location.pathname + location.search);
    return originalLogin(...args);
  };
  // Обязательно ДО первого запроса к своему API: обменивает ?code=… на токены.
  // Принудительного редиректа на вход НЕТ — гостевой режим полноценный
  // (см. README «Идея в двух режимах»).
  const loggedIn = await auth.handleRedirect();
  if (loggedIn) trackGoal("signed_in");
  renderAuthArea();
  const returnTo = loggedIn && sessionStorage.getItem("puzzle_return_to");
  if (returnTo) {
    sessionStorage.removeItem("puzzle_return_to");
    navigate(returnTo);
  } else {
    route();
  }
}
init().catch(e => {
  console.error(e);
  document.getElementById("app").innerHTML = `<p class="state-note">${t("Не удалось запуститься — обновите страницу.")}</p>`;
});
