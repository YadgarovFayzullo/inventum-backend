# INVENTUM Backend

API для CRM учебного центра [inventum-crm](https://github.com/YadgarovFayzullo/inventum-crm): ученики и родители, группы и переводы, посещаемость, оплаты, лиды, преподаватели, пользователи и роли.

**Стек:** Node 24 · Fastify · PostgreSQL 17 (`postgres`) · zod · Cloudflare R2 (`aws4fetch`) · Docker.

## Запуск

```bash
cp .env.example .env            # заполните POSTGRES_PASSWORD, при желании R2_*
docker compose up -d --build    # база + API на :3001
docker compose logs api         # пароль владельца, если OWNER_PASSWORD не задан
```

Миграции применяются сами при старте. Первый владелец создаётся из `OWNER_EMAIL` / `OWNER_PASSWORD`; остальных пользователей владелец добавляет через API (`/api/users`) или в интерфейсе: **Настройки → Пользователи**.

Без Docker: `docker compose up -d db`, затем `npm install && npm run dev`.

## Как подключить фронтенд

Cookie сессии и защита от CSRF рассчитаны на **один домен**: фронтенд и `/api` должны открываться с одного адреса. Самый простой вариант — обратный прокси с HTTPS, например Caddy:

```caddyfile
crm.example.com {
    encode zstd gzip
    handle /api/* {
        reverse_proxy api:3001
    }
    handle {
        root * /srv/frontend      # сборка фронтенда (npm run build → dist)
        try_files {path} /index.html
        file_server
    }
}
```

В этом случае задайте `COOKIE_SECURE=1` и `TRUST_PROXY=1`. Либо положите сборку фронтенда в контейнер и укажите `STATIC_DIR=/путь/к/dist` — тогда API раздаст и статику.

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `DATABASE_URL` | адрес PostgreSQL (в compose собирается сам) |
| `OWNER_EMAIL`, `OWNER_PASSWORD` | первый владелец (создаётся, только если пользователей ещё нет) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Cloudflare R2 для фото; без них фото пишутся в `UPLOADS_DIR` (только для проб) |
| `R2_ENDPOINT` | свой S3-совместимый адрес (MinIO и т. п.), по умолчанию адрес R2 |
| `COOKIE_SECURE` | `1` за HTTPS |
| `TRUST_PROXY` | `1` за обратным прокси (чтобы лимит попыток считал реальные IP) |
| `STATIC_DIR` | необязательно: папка со сборкой фронтенда |
| `PORT`, `HOST` | по умолчанию `3001`, `0.0.0.0` |

## Фото учеников (R2)

1. Создайте **приватный** бакет в R2.
2. R2 → *Manage API tokens* → токен *Object Read & Write* на этот бакет.
3. Заполните четыре переменные `R2_*`.

Загрузка — `PUT /api/students/:id/photo` (JPEG/PNG/WebP до 2 МБ, тип проверяется по содержимому). Чтение — `GET /api/students/:id/photo` только для вошедших пользователей с правами на этого ученика; публичных ссылок нет.

## API

Все пути под `/api`, JSON, вход по cookie. Изменяющие запросы должны содержать заголовок `X-Requested-With: inventum` (защита от CSRF).

| Метод и путь | Роли | Описание |
|---|---|---|
| `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` | все | вход, выход, текущий пользователь |
| `GET /bootstrap` | все | данные, доступные роли (преподаватель — только свои группы без денег и лидов) |
| `POST /students`, `PATCH /students/:id` | владелец, менеджер | ученик (при `status: left` закрываются записи в группах) |
| `PUT/DELETE/GET /students/:id/photo` | менеджер+ / чтение по правам | фото |
| `POST /enrollments`, `POST /enrollments/:id/end`, `POST /transfers` | владелец, менеджер | запись, выход из группы, перевод |
| `POST/PATCH/DELETE /groups` | владелец, менеджер | группы |
| `PUT /attendance`, `POST /attendance/bulk` | все (преподаватель — свои группы) | отметки посещаемости |
| `POST /payments`, `DELETE /payments/:id` | владелец, менеджер | оплаты |
| `POST/PATCH/DELETE /leads` | владелец, менеджер | лиды |
| `POST/PATCH/DELETE /courses`, `/teachers`, `PATCH /settings` | владелец | справочники и настройки |
| `GET/POST /users`, `PATCH/DELETE /users/:id` | владелец | пользователи |
| `POST /import` | владелец | полная замена данных (резервная копия, демо) |
| `GET /health` | без входа | проверка для Docker |

## Безопасность

- пароли — scrypt; сессия — случайный токен в httpOnly-cookie, в базе только его хэш; смена пароля завершает все сессии;
- 5 неудачных входов с одного IP на один email → блокировка на 15 минут;
- права проверяются на сервере, входные данные — схемами zod, SQL — только с параметрами;
- заголовки безопасности (CSP, X-Frame-Options и др.), защита от CSRF.

## Тесты

```bash
npm run test:db      # одноразовый Postgres на 127.0.0.1:5441 (данные в памяти)
npm test             # 19 интеграционных тестов (DATABASE_URL_TEST переопределяет адрес)
npm run test:db:down
```

Тесты стирают схему `public` в тестовой базе — не указывайте рабочую.

## Резервные копии

`docker compose exec db pg_dump -U inventum inventum > backup.sql`. Фото лежат в R2 и в дамп не входят.
