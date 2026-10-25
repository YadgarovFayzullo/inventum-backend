import { randomBytes } from 'node:crypto'
import { buildApp } from './app'
import { connect, migrate } from './db'
import { hashPassword } from './security'
import { storageFromEnv } from './storage'

const env = process.env
const url = env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL не задан. Пример: postgres://inventum:password@localhost:5432/inventum')
  process.exit(1)
}

const sql = connect(url)
await migrate(sql)

// Первый запуск: создаём владельца. Пароль берём из окружения или генерируем и один раз показываем в логе.
const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users`
if (n === 0) {
  const email = (env.OWNER_EMAIL ?? 'owner@inventum.uz').toLowerCase()
  const password = env.OWNER_PASSWORD ?? randomBytes(9).toString('base64url')
  await sql`INSERT INTO users (id, email, password_hash, role, teacher_id, name, created_at)
    VALUES (${randomBytes(16).toString('hex')}, ${email}, ${await hashPassword(password)}, 'owner', NULL, 'Владелец', ${new Date().toISOString().slice(0, 10)})`
  console.log('\n  Создан владелец')
  console.log(`  email:  ${email}`)
  console.log(`  пароль: ${env.OWNER_PASSWORD ? '(из OWNER_PASSWORD)' : password}`)
  if (!env.OWNER_PASSWORD) console.log('  Сохраните пароль — больше он нигде не показывается. Сменить можно в Настройки → Пользователи.\n')
}

const { storage, driver } = storageFromEnv(env)
const app = buildApp({
  sql,
  storage,
  staticDir: env.STATIC_DIR, // необязательно: папка со сборкой фронтенда, если раздаём её этим же сервером
  secureCookie: env.COOKIE_SECURE === '1',
  logger: env.NODE_ENV !== 'test',
})

const port = Number(env.PORT ?? 3001)
await app.listen({ port, host: env.HOST ?? '0.0.0.0' })
app.log.info(`Хранилище фото: ${driver === 'r2' ? 'Cloudflare R2' : 'локальная папка (для разработки)'}`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close()
    await sql.end({ timeout: 5 })
    process.exit(0)
  })
}
