import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import compress from '@fastify/compress'
import fstatic from '@fastify/static'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { z, ZodError } from 'zod'
import type { Course, Enrollment, Group, Lead, Payment, Student, Teacher, Transfer } from './types'
import type { Sql } from './db'
import * as S from './schemas'
import {
  createSession, destroySession, DUMMY_HASH, findSession, hashPassword, LoginLimiter, purgeExpiredSessions,
  SESSION_COOKIE, verifyPassword, type SessionUser,
} from './security'
import { sniffImage, type Storage } from './storage'

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null
    sessionToken: string | null
  }
}

type Role = SessionUser['role']
type Options = { sql: Sql; storage: Storage; staticDir?: string; secureCookie?: boolean; logger?: boolean }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

const pad = (n: number) => String(n).padStart(2, '0')
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y!, m! - 1, d! + n)
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}
const idParam = z.object({ id: S.id })

/** { camelKey: value } → { snake_column: value } только для разрешённых колонок */
const toColumns = (patch: Record<string, unknown>, map: Record<string, string>) =>
  Object.fromEntries(Object.entries(patch).filter(([k, v]) => k in map && v !== undefined).map(([k, v]) => [map[k]!, v]))

/* ---------- строки БД → DTO (те же типы, что на фронтенде) ---------- */
const toStudent = (r: Row): Student => ({
  id: r.id, firstName: r.first_name, lastName: r.last_name, phone: r.phone, parentName: r.parent_name,
  parentPhone: r.parent_phone, birthDate: r.birth_date ?? undefined, source: r.source ?? undefined,
  note: r.note ?? undefined, status: r.status, discount: r.discount, createdAt: r.created_at, photoVersion: r.photo_version,
})
const toCourse = (r: Row): Course => ({ id: r.id, name: r.name, price: r.price, durationMonths: r.duration_months, description: r.description ?? undefined })
const toTeacher = (r: Row, salary: boolean): Teacher => ({
  id: r.id, firstName: r.first_name, lastName: r.last_name, phone: r.phone, subject: r.subject,
  salaryPercent: salary ? r.salary_percent : 0, createdAt: r.created_at,
})
const toGroup = (r: Row, money: boolean): Group => ({
  id: r.id, name: r.name, courseId: r.course_id, teacherId: r.teacher_id, days: r.days, timeStart: r.time_start,
  timeEnd: r.time_end, room: r.room, price: money ? r.price : 0, capacity: r.capacity, startDate: r.start_date, archived: r.archived,
})
const toEnrollment = (r: Row): Enrollment => ({ id: r.id, studentId: r.student_id, groupId: r.group_id, startDate: r.start_date, endDate: r.end_date ?? undefined })
const toTransfer = (r: Row): Transfer => ({ id: r.id, studentId: r.student_id, fromGroupId: r.from_group_id, toGroupId: r.to_group_id, date: r.date, reason: r.reason ?? undefined })
const toPayment = (r: Row): Payment => ({ id: r.id, studentId: r.student_id, groupId: r.group_id, amount: r.amount, method: r.method, date: r.date, comment: r.comment ?? undefined })
const toLead = (r: Row): Lead => ({ id: r.id, name: r.name, phone: r.phone, courseId: r.course_id ?? undefined, source: r.source, status: r.status, note: r.note ?? undefined, createdAt: r.created_at })
const attMap = (rows: Row[]) => Object.fromEntries(rows.map((r) => [`${r.g}|${r.d}|${r.s}`, r.m]))

/** Данные, которые видит роль. Преподаватель получает только свои группы и их учеников — без денег и лидов. */
async function loadData(sql: Sql, user: SessionUser) {
  const [centerRow] = await sql`SELECT value FROM settings WHERE key = 'centerName'`
  const centerName: string = centerRow?.value ?? 'INVENTUM'
  const [teachers, courses] = await Promise.all([
    sql`SELECT * FROM teachers ORDER BY created_at, seq`,
    sql`SELECT * FROM courses ORDER BY seq`,
  ])
  const base = { courses: courses.map(toCourse), teachers: teachers.map((r) => toTeacher(r, user.role === 'owner')), settings: { centerName } }

  if (user.role === 'teacher') {
    const groups = await sql`SELECT * FROM groups WHERE teacher_id = ${user.teacherId} ORDER BY seq`
    const gids = groups.map((g) => g.id as string)
    const enrollments = await sql`SELECT * FROM enrollments WHERE group_id = ANY(${gids}::text[])`
    const sids = [...new Set(enrollments.map((e) => e.student_id as string))]
    const [students, att] = await Promise.all([
      sql`SELECT * FROM students WHERE id = ANY(${sids}::text[])`,
      sql`SELECT group_id g, date d, student_id s, mark m FROM attendance WHERE group_id = ANY(${gids}::text[])`,
    ])
    return {
      ...base,
      students: students.map(toStudent).map((s) => ({ ...s, discount: 0 })),
      groups: groups.map((g) => toGroup(g, false)),
      enrollments: enrollments.map(toEnrollment),
      transfers: [], attendance: attMap(att), payments: [], leads: [],
    }
  }

  const [students, groups, enrollments, transfers, att, payments, leads] = await Promise.all([
    sql`SELECT * FROM students ORDER BY created_at DESC, seq DESC`,
    sql`SELECT * FROM groups ORDER BY seq`,
    sql`SELECT * FROM enrollments`,
    sql`SELECT * FROM transfers ORDER BY date DESC, seq DESC`,
    sql`SELECT group_id g, date d, student_id s, mark m FROM attendance`,
    sql`SELECT * FROM payments ORDER BY date DESC, seq DESC`,
    sql`SELECT * FROM leads ORDER BY created_at DESC, seq DESC`,
  ])
  return {
    ...base,
    students: students.map(toStudent), groups: groups.map((g) => toGroup(g, true)), enrollments: enrollments.map(toEnrollment),
    transfers: transfers.map(toTransfer), attendance: attMap(att), payments: payments.map(toPayment), leads: leads.map(toLead),
  }
}

export function buildApp({ sql, storage, staticDir, secureCookie = false, logger = false }: Options): FastifyInstance {
  const app = fastify({ logger, bodyLimit: 1024 * 1024, trustProxy: process.env.TRUST_PROXY === '1' })
  const limiter = new LoginLimiter()

  app.register(cookie)
  app.register(compress, { global: true, threshold: 1024 })
  app.decorateRequest('user', null)
  app.decorateRequest('sessionToken', null)

  // Фото приходят «сырыми» байтами; тип и размер проверяются в обработчике
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp'], { parseAs: 'buffer', bodyLimit: 2 * 1024 * 1024 }, (_req, body, done) => done(null, body))

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Некорректные данные', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
    switch (err.code) {
      case '23505': return reply.code(409).send({ error: 'Такая запись уже существует' })
      case '23503': return reply.code(400).send({ error: 'Связанная запись не найдена' })
      case '23514': case '22P02': case '22007': case '22008': case '22003': return reply.code(400).send({ error: 'Некорректные данные' })
    }
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message })
    req.log.error(err)
    return reply.code(500).send({ error: 'Внутренняя ошибка сервера' })
  })

  // Заголовки безопасности
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Referrer-Policy', 'same-origin')
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    )
  })

  // Аутентификация и защита от CSRF для всех /api
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-requested-with'] !== 'inventum') {
      return reply.code(403).send({ error: 'Запрещено' })
    }
    const token = req.cookies[SESSION_COOKIE]
    if (token) {
      const user = await findSession(sql, token)
      if (user) {
        req.user = user
        req.sessionToken = token
      }
    }
    if (!req.user && req.url !== '/api/auth/login' && req.url !== '/api/auth/me' && req.url !== '/api/health') return reply.code(401).send({ error: 'Требуется вход' })
  })

  const need = (...roles: Role[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || !roles.includes(req.user.role)) return reply.code(403).send({ error: 'Недостаточно прав' })
  }
  const staff = need('owner', 'manager')
  const owner = need('owner')
  const ok = { ok: true }

  /* ---------------- auth ---------------- */
  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ email: S.email, password: z.string().min(1).max(200), remember: z.boolean().default(false) }).parse(req.body)
    if (limiter.blocked(req.ip, body.email)) return reply.code(429).send({ error: 'Слишком много попыток. Попробуйте через 15 минут.' })
    const [row] = await sql`SELECT * FROM users WHERE email = ${body.email}`
    const valid = await verifyPassword(body.password, row?.password_hash ?? DUMMY_HASH)
    if (!row || !valid) {
      limiter.fail(req.ip, body.email)
      return reply.code(401).send({ error: 'Неверный email или пароль' })
    }
    limiter.reset(req.ip, body.email)
    await purgeExpiredSessions(sql)
    const { token, ttl } = await createSession(sql, row.id, body.remember)
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: secureCookie, path: '/', ...(body.remember ? { maxAge: Math.floor(ttl / 1000) } : {}),
    })
    return { id: row.id, email: row.email, role: row.role, name: row.name, teacherId: row.teacher_id ?? '' }
  })

  app.get('/api/auth/me', async (req) => ({ user: req.user }))

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.sessionToken) await destroySession(sql, req.sessionToken)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return ok
  })

  /* ---------------- данные ---------------- */
  app.get('/api/bootstrap', async (req) => loadData(sql, req.user!))

  /* ---------------- ученики ---------------- */
  app.post('/api/students', { preHandler: staff }, async (req) => {
    const { enrollment, ...s } = S.student.extend({ enrollment: z.object({ id: S.id, groupId: S.id, startDate: S.date }).optional() }).parse(req.body)
    await sql.begin(async (tx) => {
      await tx`INSERT INTO students (id, first_name, last_name, phone, parent_name, parent_phone, birth_date, source, note, status, discount, created_at)
        VALUES (${s.id}, ${s.firstName}, ${s.lastName}, ${s.phone}, ${s.parentName}, ${s.parentPhone}, ${s.birthDate ?? null}, ${s.source ?? null}, ${s.note ?? null}, ${s.status}, ${s.discount}, ${s.createdAt})`
      if (enrollment) await tx`INSERT INTO enrollments (id, student_id, group_id, start_date) VALUES (${enrollment.id}, ${s.id}, ${enrollment.groupId}, ${enrollment.startDate})`
    })
    return ok
  })

  app.patch('/api/students/:id', { preHandler: staff }, async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const { closeOn, ...patch } = S.studentPatch.extend({ closeOn: S.date.optional() }).parse(req.body)
    const cols = toColumns(patch, {
      firstName: 'first_name', lastName: 'last_name', phone: 'phone', parentName: 'parent_name', parentPhone: 'parent_phone',
      birthDate: 'birth_date', source: 'source', note: 'note', status: 'status', discount: 'discount',
    })
    await sql.begin(async (tx) => {
      if (Object.keys(cols).length) {
        const r = await tx`UPDATE students SET ${tx(cols)} WHERE id = ${id}`
        if (r.count === 0) throw Object.assign(new Error('Ученик не найден'), { statusCode: 404 })
      }
      // Ушедший ученик перестаёт получать начисления
      if (patch.status === 'left') await tx`UPDATE enrollments SET end_date = ${closeOn ?? today()} WHERE student_id = ${id} AND end_date IS NULL`
    })
    return reply.send(ok)
  })

  /* ---------------- фото учеников (Cloudflare R2) ---------------- */
  // Читать может сотрудник; преподаватель — только учеников своих групп
  const canSeeStudent = async (user: SessionUser, studentId: string) => {
    if (user.role !== 'teacher') return true
    const [r] = await sql`SELECT 1 FROM enrollments e JOIN groups g ON g.id = e.group_id WHERE e.student_id = ${studentId} AND g.teacher_id = ${user.teacherId} LIMIT 1`
    return !!r
  }

  app.put('/api/students/:id/photo', { preHandler: staff, bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const body = req.body
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(415).send({ error: 'Нужно изображение JPEG, PNG или WebP' })
    const type = sniffImage(body)
    if (!type) return reply.code(415).send({ error: 'Файл не похож на изображение JPEG, PNG или WebP' })
    const [st] = await sql`SELECT photo_version FROM students WHERE id = ${id}`
    if (!st) return reply.code(404).send({ error: 'Ученик не найден' })
    const version = (st.photo_version as number) + 1
    await storage.put(`students/${id}/${version}`, body, type)
    await sql`UPDATE students SET photo_version = ${version}, photo_type = ${type} WHERE id = ${id}`
    if (version > 1) storage.delete(`students/${id}/${version - 1}`).catch((e) => req.log.warn(e, 'old photo cleanup failed'))
    return { photoVersion: version }
  })

  app.delete('/api/students/:id/photo', { preHandler: staff }, async (req) => {
    const { id } = idParam.parse(req.params)
    const [st] = await sql`SELECT photo_version FROM students WHERE id = ${id}`
    if (st && st.photo_version > 0) {
      await sql`UPDATE students SET photo_version = 0, photo_type = NULL WHERE id = ${id}`
      storage.delete(`students/${id}/${st.photo_version}`).catch((e) => req.log.warn(e, 'photo cleanup failed'))
    }
    return ok
  })

  app.get('/api/students/:id/photo', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    if (!(await canSeeStudent(req.user!, id))) return reply.code(403).send({ error: 'Недостаточно прав' })
    const [st] = await sql`SELECT photo_version FROM students WHERE id = ${id}`
    if (!st || st.photo_version === 0) return reply.code(404).send({ error: 'Фото нет' })
    const file = await storage.get(`students/${id}/${st.photo_version}`)
    if (!file) return reply.code(404).send({ error: 'Фото нет' })
    // версия в адресе меняется при каждой загрузке, поэтому браузер может кэшировать надолго
    return reply.header('Cache-Control', 'private, max-age=31536000, immutable').type(file.contentType).send(file.body)
  })

  /* ---------------- записи в группы и переводы ---------------- */
  app.post('/api/enrollments', { preHandler: staff }, async (req) => {
    const e = S.enrollment.omit({ endDate: true }).parse(req.body)
    const [exists] = await sql`SELECT 1 FROM enrollments WHERE student_id = ${e.studentId} AND group_id = ${e.groupId} AND end_date IS NULL`
    if (!exists) await sql`INSERT INTO enrollments (id, student_id, group_id, start_date) VALUES (${e.id}, ${e.studentId}, ${e.groupId}, ${e.startDate})`
    return ok
  })

  app.post('/api/enrollments/:id/end', { preHandler: staff }, async (req) => {
    const { id } = idParam.parse(req.params)
    const { date } = z.object({ date: S.date }).parse(req.body)
    await sql.begin(async (tx) => {
      await tx`UPDATE enrollments SET end_date = ${date} WHERE id = ${id}`
      await tx`DELETE FROM enrollments WHERE id = ${id} AND end_date < start_date` // дата ухода раньше прихода — запись не имела смысла
    })
    return ok
  })

  app.post('/api/transfers', { preHandler: staff }, async (req) => {
    const t = S.transferRec.extend({ enrollmentId: S.id }).parse(req.body)
    await sql.begin(async (tx) => {
      await tx`UPDATE enrollments SET end_date = ${addDays(t.date, -1)} WHERE student_id = ${t.studentId} AND group_id = ${t.fromGroupId} AND end_date IS NULL`
      await tx`DELETE FROM enrollments WHERE student_id = ${t.studentId} AND group_id = ${t.fromGroupId} AND end_date < start_date`
      await tx`INSERT INTO enrollments (id, student_id, group_id, start_date) VALUES (${t.enrollmentId}, ${t.studentId}, ${t.toGroupId}, ${t.date})`
      await tx`INSERT INTO transfers (id, student_id, from_group_id, to_group_id, date, reason) VALUES (${t.id}, ${t.studentId}, ${t.fromGroupId}, ${t.toGroupId}, ${t.date}, ${t.reason ?? null})`
    })
    return ok
  })

  /* ---------------- группы ---------------- */
  app.post('/api/groups', { preHandler: staff }, async (req) => {
    const g = S.group.parse(req.body)
    await sql`INSERT INTO groups (id, name, course_id, teacher_id, days, time_start, time_end, room, price, capacity, start_date, archived)
      VALUES (${g.id}, ${g.name}, ${g.courseId}, ${g.teacherId}, ${sql.json(g.days)}, ${g.timeStart}, ${g.timeEnd}, ${g.room}, ${g.price}, ${g.capacity}, ${g.startDate}, ${g.archived})`
    return ok
  })
  app.patch('/api/groups/:id', { preHandler: staff }, async (req) => {
    const { id } = idParam.parse(req.params)
    const { days, ...patch } = S.groupPatch.parse(req.body)
    const cols = toColumns(patch, {
      name: 'name', courseId: 'course_id', teacherId: 'teacher_id', timeStart: 'time_start', timeEnd: 'time_end',
      room: 'room', price: 'price', capacity: 'capacity', startDate: 'start_date', archived: 'archived',
    })
    await sql.begin(async (tx) => {
      if (Object.keys(cols).length) await tx`UPDATE groups SET ${tx(cols)} WHERE id = ${id}`
      if (days) await tx`UPDATE groups SET days = ${tx.json(days)} WHERE id = ${id}`
    })
    return ok
  })
  app.delete('/api/groups/:id', { preHandler: staff }, async (req) => {
    await sql`DELETE FROM groups WHERE id = ${idParam.parse(req.params).id}`
    return ok
  })

  /* ---------------- курсы и преподаватели (владелец) ---------------- */
  app.post('/api/courses', { preHandler: owner }, async (req) => {
    const c = S.course.parse(req.body)
    await sql`INSERT INTO courses (id, name, price, duration_months, description) VALUES (${c.id}, ${c.name}, ${c.price}, ${c.durationMonths}, ${c.description ?? null})`
    return ok
  })
  app.patch('/api/courses/:id', { preHandler: owner }, async (req) => {
    const { id } = idParam.parse(req.params)
    const cols = toColumns(S.coursePatch.parse(req.body), { name: 'name', price: 'price', durationMonths: 'duration_months', description: 'description' })
    if (Object.keys(cols).length) await sql`UPDATE courses SET ${sql(cols)} WHERE id = ${id}`
    return ok
  })
  app.delete('/api/courses/:id', { preHandler: owner }, async (req) => {
    await sql`DELETE FROM courses WHERE id = ${idParam.parse(req.params).id}`
    return ok
  })

  app.post('/api/teachers', { preHandler: owner }, async (req) => {
    const t = S.teacher.parse(req.body)
    await sql`INSERT INTO teachers (id, first_name, last_name, phone, subject, salary_percent, created_at)
      VALUES (${t.id}, ${t.firstName}, ${t.lastName}, ${t.phone}, ${t.subject}, ${t.salaryPercent}, ${t.createdAt})`
    return ok
  })
  app.patch('/api/teachers/:id', { preHandler: owner }, async (req) => {
    const { id } = idParam.parse(req.params)
    const cols = toColumns(S.teacherPatch.parse(req.body), { firstName: 'first_name', lastName: 'last_name', phone: 'phone', subject: 'subject', salaryPercent: 'salary_percent' })
    if (Object.keys(cols).length) await sql`UPDATE teachers SET ${sql(cols)} WHERE id = ${id}`
    return ok
  })
  app.delete('/api/teachers/:id', { preHandler: owner }, async (req) => {
    const { id } = idParam.parse(req.params)
    await sql.begin(async (tx) => {
      await tx`DELETE FROM users WHERE teacher_id = ${id} AND role = 'teacher'` // логин удалённого преподавателя больше не нужен
      await tx`DELETE FROM teachers WHERE id = ${id}`
    })
    return ok
  })

  /* ---------------- посещаемость (доступна и преподавателю — только в своих группах) ---------------- */
  const canMark = async (req: FastifyRequest, groupId: string) => {
    if (req.user!.role !== 'teacher') return true
    const [g] = await sql`SELECT teacher_id FROM groups WHERE id = ${groupId}`
    return !!g && g.teacher_id === req.user!.teacherId
  }
  app.put('/api/attendance', async (req, reply) => {
    const b = z.object({ groupId: S.id, date: S.date, studentId: S.id, mark: S.mark.nullable() }).parse(req.body)
    if (!(await canMark(req, b.groupId))) return reply.code(403).send({ error: 'Это группа другого преподавателя' })
    if (b.mark) {
      await sql`INSERT INTO attendance (group_id, date, student_id, mark) VALUES (${b.groupId}, ${b.date}, ${b.studentId}, ${b.mark})
        ON CONFLICT (group_id, date, student_id) DO UPDATE SET mark = EXCLUDED.mark`
    } else {
      await sql`DELETE FROM attendance WHERE group_id = ${b.groupId} AND date = ${b.date} AND student_id = ${b.studentId}`
    }
    return ok
  })
  app.post('/api/attendance/bulk', async (req, reply) => {
    const b = z.object({ groupId: S.id, date: S.date, studentIds: z.array(S.id).max(500), mark: S.mark }).parse(req.body)
    if (!(await canMark(req, b.groupId))) return reply.code(403).send({ error: 'Это группа другого преподавателя' })
    if (b.studentIds.length) {
      await sql`INSERT INTO attendance (group_id, date, student_id, mark)
        SELECT ${b.groupId}, ${b.date}, unnest(${b.studentIds}::text[]), ${b.mark}
        ON CONFLICT (group_id, date, student_id) DO UPDATE SET mark = EXCLUDED.mark`
    }
    return ok
  })

  /* ---------------- оплаты и лиды ---------------- */
  app.post('/api/payments', { preHandler: staff }, async (req) => {
    const p = S.payment.parse(req.body)
    await sql`INSERT INTO payments (id, student_id, group_id, amount, method, date, comment)
      VALUES (${p.id}, ${p.studentId}, ${p.groupId}, ${p.amount}, ${p.method}, ${p.date}, ${p.comment ?? null})`
    return ok
  })
  app.delete('/api/payments/:id', { preHandler: staff }, async (req) => {
    await sql`DELETE FROM payments WHERE id = ${idParam.parse(req.params).id}`
    return ok
  })

  app.post('/api/leads', { preHandler: staff }, async (req) => {
    const l = S.lead.parse(req.body)
    await sql`INSERT INTO leads (id, name, phone, course_id, source, status, note, created_at)
      VALUES (${l.id}, ${l.name}, ${l.phone}, ${l.courseId ?? null}, ${l.source}, ${l.status}, ${l.note ?? null}, ${l.createdAt})`
    return ok
  })
  app.patch('/api/leads/:id', { preHandler: staff }, async (req) => {
    const { id } = idParam.parse(req.params)
    const cols = toColumns(S.leadPatch.parse(req.body), { name: 'name', phone: 'phone', courseId: 'course_id', source: 'source', status: 'status', note: 'note' })
    if (Object.keys(cols).length) await sql`UPDATE leads SET ${sql(cols)} WHERE id = ${id}`
    return ok
  })
  app.delete('/api/leads/:id', { preHandler: staff }, async (req) => {
    await sql`DELETE FROM leads WHERE id = ${idParam.parse(req.params).id}`
    return ok
  })

  /* ---------------- настройки, импорт, пользователи (владелец) ---------------- */
  app.patch('/api/settings', { preHandler: owner }, async (req) => {
    const { centerName } = z.object({ centerName: z.string().trim().min(1).max(80) }).parse(req.body)
    await sql`INSERT INTO settings (key, value) VALUES ('centerName', ${centerName}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    return ok
  })

  app.post('/api/import', { preHandler: owner, bodyLimit: 50 * 1024 * 1024 }, async (req) => {
    const d = S.importData.parse(req.body)
    await sql.begin(async (tx) => {
      // порядок важен из-за внешних ключей; списки «новые сверху» вставляем с конца, чтобы порядок не перевернулся
      await tx`TRUNCATE attendance, payments, transfers, enrollments, leads, groups, students, teachers, courses`
      for (const c of d.courses) await tx`INSERT INTO courses (id, name, price, duration_months, description) VALUES (${c.id}, ${c.name}, ${c.price}, ${c.durationMonths}, ${c.description ?? null})`
      for (const t of d.teachers) await tx`INSERT INTO teachers (id, first_name, last_name, phone, subject, salary_percent, created_at) VALUES (${t.id}, ${t.firstName}, ${t.lastName}, ${t.phone}, ${t.subject}, ${t.salaryPercent}, ${t.createdAt})`
      for (const s of [...d.students].reverse()) await tx`INSERT INTO students (id, first_name, last_name, phone, parent_name, parent_phone, birth_date, source, note, status, discount, created_at) VALUES (${s.id}, ${s.firstName}, ${s.lastName}, ${s.phone}, ${s.parentName}, ${s.parentPhone}, ${s.birthDate ?? null}, ${s.source ?? null}, ${s.note ?? null}, ${s.status}, ${s.discount}, ${s.createdAt})`
      for (const g of d.groups) await tx`INSERT INTO groups (id, name, course_id, teacher_id, days, time_start, time_end, room, price, capacity, start_date, archived) VALUES (${g.id}, ${g.name}, ${g.courseId}, ${g.teacherId}, ${tx.json(g.days)}, ${g.timeStart}, ${g.timeEnd}, ${g.room}, ${g.price}, ${g.capacity}, ${g.startDate}, ${g.archived})`
      for (const e of d.enrollments) await tx`INSERT INTO enrollments (id, student_id, group_id, start_date, end_date) VALUES (${e.id}, ${e.studentId}, ${e.groupId}, ${e.startDate}, ${e.endDate ?? null})`
      for (const t of [...d.transfers].reverse()) await tx`INSERT INTO transfers (id, student_id, from_group_id, to_group_id, date, reason) VALUES (${t.id}, ${t.studentId}, ${t.fromGroupId}, ${t.toGroupId}, ${t.date}, ${t.reason ?? null})`
      const att = Object.entries(d.attendance).map(([k, m]) => {
        const [g, dt, s] = k.split('|') as [string, string, string]
        return { group_id: g, date: dt, student_id: s, mark: m }
      })
      for (let i = 0; i < att.length; i += 1000) await tx`INSERT INTO attendance ${tx(att.slice(i, i + 1000))} ON CONFLICT DO NOTHING`
      for (const p of [...d.payments].reverse()) await tx`INSERT INTO payments (id, student_id, group_id, amount, method, date, comment) VALUES (${p.id}, ${p.studentId}, ${p.groupId}, ${p.amount}, ${p.method}, ${p.date}, ${p.comment ?? null})`
      for (const l of [...d.leads].reverse()) await tx`INSERT INTO leads (id, name, phone, course_id, source, status, note, created_at) VALUES (${l.id}, ${l.name}, ${l.phone}, ${l.courseId ?? null}, ${l.source}, ${l.status}, ${l.note ?? null}, ${l.createdAt})`
      await tx`INSERT INTO settings (key, value) VALUES ('centerName', ${d.settings.centerName}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    })
    return ok
  })

  const userDto = (r: Row) => ({ id: r.id, email: r.email, role: r.role, name: r.name, teacherId: r.teacher_id ?? '' })
  app.get('/api/users', { preHandler: owner }, async () => (await sql`SELECT * FROM users ORDER BY created_at, email`).map(userDto))

  app.post('/api/users', { preHandler: owner }, async (req, reply) => {
    const b = z.object({ email: S.email, password: S.password, role: S.role, teacherId: S.id.optional(), name: z.string().trim().max(80).optional() }).parse(req.body)
    let name = b.name || (b.role === 'owner' ? 'Владелец' : 'Менеджер')
    let teacherId: string | null = null
    if (b.role === 'teacher') {
      const [t] = b.teacherId ? await sql`SELECT first_name, last_name FROM teachers WHERE id = ${b.teacherId}` : []
      if (!t) return reply.code(400).send({ error: 'Выберите преподавателя' })
      teacherId = b.teacherId!
      name = `${t.first_name} ${t.last_name}`
    }
    const id = randomUUID()
    const [row] = await sql`INSERT INTO users (id, email, password_hash, role, teacher_id, name, created_at)
      VALUES (${id}, ${b.email}, ${await hashPassword(b.password)}, ${b.role}, ${teacherId}, ${name}, ${today()}) RETURNING *`
    return userDto(row)
  })

  app.patch('/api/users/:id', { preHandler: owner }, async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(60) }).parse(req.params)
    const b = z.object({ password: S.password }).parse(req.body)
    const r = await sql`UPDATE users SET password_hash = ${await hashPassword(b.password)} WHERE id = ${id}`
    if (r.count === 0) return reply.code(404).send({ error: 'Пользователь не найден' })
    await sql`DELETE FROM sessions WHERE user_id = ${id}` // после смены пароля старые входы недействительны
    return ok
  })

  app.delete('/api/users/:id', { preHandler: owner }, async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(60) }).parse(req.params)
    if (id === req.user!.id) return reply.code(400).send({ error: 'Нельзя удалить самого себя' })
    await sql`DELETE FROM users WHERE id = ${id}`
    return ok
  })

  app.get('/api/health', async () => {
    await sql`SELECT 1`
    return ok
  })

  /* ---------------- статика (production) ---------------- */
  if (staticDir && existsSync(staticDir)) {
    app.register(fstatic, {
      root: path.resolve(staticDir), wildcard: false, maxAge: '1y', immutable: true,
      setHeaders: (res, p) => { if (p.endsWith('index.html')) res.header('Cache-Control', 'no-cache') },
    })
    app.get('/*', async (req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: 'Не найдено' }) : reply.sendFile('index.html')))
  }

  return app
}
