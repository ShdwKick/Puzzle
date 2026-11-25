FROM node:24-alpine

# vips — единственная внешняя программа в образе (см. lib/thumbs.js и правку
# «Миниатюры картинок»). Нужна, чтобы пережимать обложки под тот размер, в
# котором они реально показываются: до этого карточка в сетке 318×238 грузила
# исходные 1880×1253, и главная тянула 3.5 МБ.
#
# Это НЕ нарушает «зависимостей нет вовсе» ниже: речь про npm — ни
# package.json, ни node_modules по-прежнему нет, код остаётся на голом Node.
# vips — зависимость ОБРАЗА, не кода: сервис без неё запускается и работает,
# просто отдаёт обложки в исходном размере (см. фолбэк в serveStatic).
# Выбран vips, а не imagemagick: вчетверо меньше по месту в образе и заметно
# быстрее на ровно этой задаче — вписать фото в квадрат и сохранить в WebP.
RUN apk add --no-cache vips-tools

WORKDIR /app

# Копируем только то, что реально нужно в рантайме.
# Зависимостей нет вовсе: SQLite — встроенный node:sqlite, проверка токенов —
# auth-client.js на 200 строк. Поэтому ни npm install, ни node_modules здесь нет.
#
# Модули берём маской, а не по одному: перечисление уже подводило в других
# сервисах — забытый файл в COPY роняет контейнер в цикле с MODULE_NOT_FOUND.
# Маска захватывает server.js, auth-client.js, admin-internal.js и всё, что
# появится дальше. Локальный запускатор dev.mjs сюда не попадает — он .mjs.
COPY *.js ./
COPY index.html ./
COPY robots.txt ./
COPY llms.txt ./
# sitemap.xml больше НЕ копируется — теперь генерируется на лету
# (GET /sitemap.xml в server.js, см. план «Прямые ссылки вместо #/ +
# страница категорий»), статичный файл был бы просто мёртвым грузом.
COPY assets/ ./assets/
# lib/ (mailer.js, emailTemplates.js — см. план «Разделение модерации... +
# письма») — отдельная строка, маска *.js на строке выше берёт только корень
# каталога, не подкаталоги. Ровно тот случай, о котором предупреждает
# комментарий выше про "забытый файл роняет контейнер MODULE_NOT_FOUND" —
# сюда же он и попал при первой версии этого Dockerfile.
COPY lib/ ./lib/
# scripts/ — разовые утилиты обслуживания, запускаются руками внутри
# контейнера (docker compose exec). Сейчас там backfill-thumbs.mjs: прогреть
# миниатюры для уже загруженных обложек, чтобы первое пережатие не попало в
# ответ живому посетителю (см. lib/thumbs.js).
COPY scripts/ ./scripts/

# Проверка на этапе сборки: пропавший модуль ломает сборку, а не контейнер на
# сервере. Запускать сервер нельзя — он бы занял порт и повис, поэтому только
# наличие файлов и разбор синтаксиса.
RUN set -e; \
    for f in server.js auth-client.js admin-internal.js index.html lib/mailer.js lib/emailTemplates.js lib/thumbs.js; do \
      test -f "$f" || { echo "В образе нет $f — проверьте COPY в Dockerfile"; exit 1; }; \
    done; \
    for f in server.js auth-client.js admin-internal.js lib/mailer.js lib/emailTemplates.js lib/thumbs.js; do node --check "$f"; done; \
    command -v vips >/dev/null || { echo "В образе нет vips — обложки будут отдаваться в исходном размере, см. apk add выше"; exit 1; }; \
    for f in assets/app.js assets/puzzle-shapes.js assets/auth-client.js; do node --check "$f"; done

# Каталог данных: store.db. В контейнере он смонтирован томом —
# см. docker-compose.yml.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV HOST=0.0.0.0
ENV PORT=8796
ENV DATA_DIR=/app/data

EXPOSE 8796
VOLUME ["/app/data"]

CMD ["node", "server.js"]
