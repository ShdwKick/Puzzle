/**
 * Частотность запросов через Wordstat API (Yandex Search API v2).
 *
 * Зачем: подбирать, под что писать заголовки/описания страниц, по реальным
 * числам, а не на ощупь. Скрипт разовый, по требованию — в сервис он не
 * входит и из server.js не вызывается.
 *
 * Запуск:
 *   YANDEX_API_KEY=... YANDEX_FOLDER_ID=... node scripts/wordstat-top.mjs "пазлы онлайн"
 *   YANDEX_API_KEY=... YANDEX_FOLDER_ID=... node scripts/wordstat-top.mjs      # весь список ниже
 *
 * Доступ (всё это заводится один раз в консоли Yandex Cloud):
 *   1. каталог (folder) — его идентификатор идёт в YANDEX_FOLDER_ID;
 *   2. сервисный аккаунт с ролью search-api.webSearch.user;
 *   3. API-ключ этого аккаунта — в YANDEX_API_KEY (нужна СЕКРЕТНАЯ часть
 *      ключа, не его идентификатор).
 * Вместо API-ключа можно отдать IAM-токен в YANDEX_IAM_TOKEN — тогда
 * заголовок уходит как Bearer (см. authHeader ниже). Сервис платный,
 * тарификация — за запросы.
 *
 * Ключ живёт ТОЛЬКО в окружении: в репозиторий он не коммитится и в вывод
 * скрипта не попадает — тот же принцип, что у GIGACHAT_AUTH_KEY и
 * ADMIN_INTERNAL_KEY (см. README).
 */

const ENDPOINT = "https://searchapi.api.cloud.yandex.net/v2/wordstat/topRequests";
// 225 — Россия. Дерево регионов отдаёт отдельный метод regionsTree, но для
// нашей задачи достаточно страны целиком.
const REGION_RUSSIA = "225";
const NUM_PHRASES = 50;

// Затравки: то, вокруг чего живёт сервис. Wordstat на каждую вернёт топ
// запросов, которые её содержат, — из них и выбираем, подо что писать.
const DEFAULT_SEEDS = [
  "пазлы онлайн",
  "собрать пазл онлайн",
  "пазлы онлайн бесплатно",
  "пазл из своей фотографии",
  "пазлы для детей онлайн",
  "собрать пазл вдвоём",
  "что собираем",
];

function authHeader() {
  const apiKey = process.env.YANDEX_API_KEY;
  if (apiKey) return `Api-Key ${apiKey}`;
  const iam = process.env.YANDEX_IAM_TOKEN;
  if (iam) return `Bearer ${iam}`;
  console.error(
    "Не задан ни YANDEX_API_KEY, ни YANDEX_IAM_TOKEN — Wordstat без них не ответит.\n" +
    "См. шапку этого файла: нужен сервисный аккаунт с ролью search-api.webSearch.user."
  );
  process.exit(1);
}

async function top(phrase, auth, folderId) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      phrase,
      numPhrases: String(NUM_PHRASES),
      regions: [REGION_RUSSIA],
      devices: ["DEVICE_ALL"],
      ...(folderId ? { folderId } : {}),
    }),
  });
  if (!res.ok) {
    // Тело ответа Яндекса кладём как есть: оно объясняет отказ (нет роли,
    // кончилась квота, не тот каталог) куда точнее, чем код состояния.
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

const seeds = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SEEDS;
const auth = authHeader();
const folderId = process.env.YANDEX_FOLDER_ID || "";
if (!folderId) console.error("[!] YANDEX_FOLDER_ID не задан — для сервисного аккаунта каталог определится сам, для пользовательского запрос упадёт.\n");

for (const seed of seeds) {
  console.log(`\n═══ ${seed} ═══`);
  let data;
  try {
    data = await top(seed, auth, folderId);
  } catch (e) {
    console.error(`  не получилось: ${e.message}`);
    continue;
  }
  console.log(`  всего показов по фразе: ${data.totalCount}\n`);
  const rows = (data.results || []).map(r => ({ Запрос: r.phrase, Показов: Number(r.count) }));
  if (rows.length) console.table(rows);
  const assoc = (data.associations || []).slice(0, 15).map(r => ({ Похожий: r.phrase, Показов: Number(r.count) }));
  if (assoc.length) { console.log("  похожие запросы:"); console.table(assoc); }
}
