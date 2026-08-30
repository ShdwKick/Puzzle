FROM node:24-alpine

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

# Проверка на этапе сборки: пропавший модуль ломает сборку, а не контейнер на
# сервере. Запускать сервер нельзя — он бы занял порт и повис, поэтому только
# наличие файлов и разбор синтаксиса.
RUN set -e; \
    for f in server.js auth-client.js admin-internal.js index.html lib/mailer.js lib/emailTemplates.js; do \
      test -f "$f" || { echo "В образе нет $f — проверьте COPY в Dockerfile"; exit 1; }; \
    done; \
    for f in server.js auth-client.js admin-internal.js lib/mailer.js lib/emailTemplates.js; do node --check "$f"; done; \
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
