import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app'
import { connect, migrate, type Sql } from './db'
import { hashPassword } from './security'
import { localStorage } from './storage'

const URL = process.env.DATABASE_URL_TEST ?? 'postgres://inventum:test@127.0.0.1:5441/inventum_test'

let sql: Sql
let app: FastifyInstance

type Who = { cookie: string }
const H = { 'x-requested-with': 'inventum' }
const call = async (who: Who | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.inject({
    method, url, payload: payload as never,
    headers: { ...H, ...(who ? { cookie: who.cookie } : {}), ...headers },
  })
  let body: any = null
  try { body = res.json() } catch { body = res.rawPayload }
  return { status: res.statusCode, body, res }
}
const login = async (email: string, password: string, remember = true): Promise<Who> => {
  const r = await call(null, 'POST', '/api/auth/login', { email, password, remember })
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.body)}`)
  const c = r.res.cookies.find((x) => x.name === 'inv_session')!
  return { cookie: `${c.name}=${c.value}` }
}

const d = (n: number) => `2026-10-${String(n).padStart(2, '0')}`
const student = (id: string, extra = {}) => ({ id, firstName: 'Азиз', lastName: 'Каримов', phone: '901234567', parentName: 'Рустам', parentPhone: '931112233', status: 'active', discount: 0, createdAt: d(1), ...extra })
const group = (id: string, teacherId: string, extra = {}) => ({ id, name: `G ${id}`, courseId: 'c1', teacherId, days: [1, 3, 5], timeStart: '10:00', timeEnd: '11:30', room: '1', price: 450000, capacity: 10, startDate: d(1), archived: false, ...extra })
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

describe('API', () => {
  let owner: Who, manager: Who, teacher1: Who, teacher2: Who

  before(async () => {
    sql = connect(URL, 4)
    await sql`DROP SCHEMA public CASCADE`
    await sql`CREATE SCHEMA public`
    await migrate(sql)
    await sql`INSERT INTO users (id, email, password_hash, role, name, created_at) VALUES ('u-owner', 'owner@test.uz', ${await hashPassword('owner-pass-1')}, 'owner', 'Владелец', '2026-10-01')`
    app = buildApp({ sql, storage: localStorage(mkdtempSync(path.join(tmpdir(), 'inv-up-'))) })
    await app.ready()
    owner = await login('owner@test.uz', 'owner-pass-1')
  })
  after(async () => {
    await app.close()
    await sql.end({ timeout: 2 })
  })

  it('закрывает API без входа и без CSRF-заголовка', async () => {
    assert.equal((await call(null, 'GET', '/api/bootstrap')).status, 401)
    assert.equal((await call(null, 'POST', '/api/students', student('x'), { 'x-requested-with': '' })).status, 403)
    assert.equal((await call(owner, 'POST', '/api/students', student('x'), { 'x-requested-with': '' })).status, 403)
    assert.equal((await call(null, 'GET', '/api/health')).status, 200)
  })

  it('вход: неверный пароль, me, выход', async () => {
    assert.equal((await call(null, 'POST', '/api/auth/login', { email: 'owner@test.uz', password: 'nope' })).status, 401)
    assert.equal((await call(null, 'POST', '/api/auth/login', { email: 'nobody@test.uz', password: 'nope' })).status, 401)
    const me = await call(owner, 'GET', '/api/auth/me')
    assert.equal(me.body.user.role, 'owner')
    const tmp = await login('OWNER@test.uz ', 'owner-pass-1', false) // регистр и пробелы не важны
    assert.equal((await call(tmp, 'POST', '/api/auth/logout')).status, 200)
    assert.equal((await call(tmp, 'GET', '/api/bootstrap')).status, 401)
  })

  it('владелец создаёт данные: курс, преподавателей, группы, ученика', async () => {
    assert.equal((await call(owner, 'POST', '/api/courses', { id: 'c1', name: 'English', price: 450000, durationMonths: 9 })).status, 200)
    for (const [id, name] of [['t1', 'Дилноза'], ['t2', 'Жахонгир']] as const)
      assert.equal((await call(owner, 'POST', '/api/teachers', { id, firstName: name, lastName: 'Тест', phone: '', subject: 'EN', salaryPercent: 40, createdAt: d(1) })).status, 200)
    assert.equal((await call(owner, 'POST', '/api/groups', group('g1', 't1'))).status, 200)
    assert.equal((await call(owner, 'POST', '/api/groups', group('g2', 't2'))).status, 200)
    assert.equal((await call(owner, 'POST', '/api/students', { ...student('s1'), enrollment: { id: 'e1', groupId: 'g1', startDate: d(1) } })).status, 200)
    assert.equal((await call(owner, 'POST', '/api/students', { ...student('s2', { firstName: 'Мадина' }), enrollment: { id: 'e2', groupId: 'g2', startDate: d(1) } })).status, 200)
    assert.equal((await call(owner, 'POST', '/api/payments', { id: 'p1', studentId: 's1', groupId: 'g1', amount: 450000, method: 'cash', date: d(2) })).status, 200)
    assert.equal((await call(owner, 'POST', '/api/leads', { id: 'l1', name: 'Лид', phone: '901112233', source: 'Instagram', status: 'new', createdAt: d(2) })).status, 200)
  })

  it('валидация: плохая дата, дубликат id, лишние поля игнорируются', async () => {
    assert.equal((await call(owner, 'POST', '/api/students', student('bad', { createdAt: '2026-13-45' }))).status, 400)
    assert.equal((await call(owner, 'POST', '/api/students', student('s1'))).status, 409)
    assert.equal((await call(owner, 'POST', '/api/payments', { id: 'p9', studentId: 'ghost', groupId: 'g1', amount: 1000, method: 'cash', date: d(2) })).status, 400)
    assert.equal((await call(owner, 'POST', '/api/payments', { id: 'p9', studentId: 's1', groupId: 'g1', amount: -5, method: 'cash', date: d(2) })).status, 400)
    assert.equal((await call(owner, 'POST', '/api/students', student("x'; DROP TABLE students;--"))).status, 400)
    assert.equal((await call(owner, 'GET', '/api/bootstrap')).body.students.length, 2)
  })

  it('владелец заводит пользователей', async () => {
    const m = await call(owner, 'POST', '/api/users', { email: 'Manager@test.uz', password: 'manager-pass-1', role: 'manager' })
    assert.equal(m.status, 200)
    assert.equal(m.body.email, 'manager@test.uz')
    assert.equal((await call(owner, 'POST', '/api/users', { email: 't1@test.uz', password: 'teacher-pass-1', role: 'teacher', teacherId: 't1' })).status, 200)
    assert.equal((await call(owner, 'POST', '/api/users', { email: 't2@test.uz', password: 'teacher-pass-2', role: 'teacher', teacherId: 't2' })).status, 200)
    assert.equal((await call(owner, 'POST', '/api/users', { email: 'x@test.uz', password: 'teacher-pass-2', role: 'teacher' })).status, 400, 'teacher без teacherId')
    assert.equal((await call(owner, 'POST', '/api/users', { email: 'weak@test.uz', password: '123', role: 'manager' })).status, 400, 'короткий пароль')
    assert.equal((await call(owner, 'POST', '/api/users', { email: 'manager@test.uz', password: 'manager-pass-1', role: 'manager' })).status, 409)
    manager = await login('manager@test.uz', 'manager-pass-1')
    teacher1 = await login('t1@test.uz', 'teacher-pass-1')
    teacher2 = await login('t2@test.uz', 'teacher-pass-2')
  })

  it('менеджер: видит деньги и лиды, но не владельческое', async () => {
    const b = (await call(manager, 'GET', '/api/bootstrap')).body
    assert.equal(b.payments.length, 1)
    assert.equal(b.leads.length, 1)
    assert.equal(b.groups[0].price, 450000)
    assert.ok(b.teachers.every((t: any) => t.salaryPercent === 0), 'зарплаты скрыты от менеджера')
    assert.equal((await call(manager, 'GET', '/api/users')).status, 403)
    assert.equal((await call(manager, 'PATCH', '/api/settings', { centerName: 'X' })).status, 403)
    assert.equal((await call(manager, 'POST', '/api/courses', { id: 'c2', name: 'X', price: 1, durationMonths: 1 })).status, 403)
    assert.equal((await call(manager, 'POST', '/api/import', {})).status, 403)
    assert.equal((await call(manager, 'POST', '/api/students', student('s3'))).status, 200)
    assert.equal((await call(manager, 'POST', '/api/payments', { id: 'p2', studentId: 's3', groupId: 'g1', amount: 1000, method: 'card', date: d(3) })).status, 200)
  })

  it('преподаватель: только свои группы, без денег и лидов', async () => {
    const b = (await call(teacher1, 'GET', '/api/bootstrap')).body
    assert.deepEqual(b.groups.map((g: any) => g.id), ['g1'])
    assert.equal(b.groups[0].price, 0, 'цена скрыта')
    assert.deepEqual(b.students.map((s: any) => s.id), ['s1'], 'только ученики своей группы')
    assert.equal(b.payments.length, 0)
    assert.equal(b.leads.length, 0)
    assert.equal(b.transfers.length, 0)
    assert.ok(b.teachers.every((t: any) => t.salaryPercent === 0))
    for (const [m, u] of [['GET', '/api/users'], ['POST', '/api/payments'], ['POST', '/api/students'], ['POST', '/api/groups'], ['POST', '/api/leads'], ['POST', '/api/enrollments'], ['POST', '/api/transfers'], ['PATCH', '/api/settings'], ['POST', '/api/import']] as const)
      assert.equal((await call(teacher1, m, u, {})).status, 403, `${m} ${u}`)
  })

  it('посещаемость: преподаватель — только своя группа', async () => {
    const mark = { groupId: 'g1', date: d(5), studentId: 's1', mark: 'present' }
    assert.equal((await call(teacher1, 'PUT', '/api/attendance', mark)).status, 200)
    assert.equal((await call(teacher2, 'PUT', '/api/attendance', mark)).status, 403, 'чужая группа')
    assert.equal((await call(teacher2, 'POST', '/api/attendance/bulk', { groupId: 'g1', date: d(5), studentIds: ['s1'], mark: 'late' })).status, 403)
    assert.equal((await call(teacher1, 'PUT', '/api/attendance', { ...mark, mark: 'absent' })).status, 200, 'смена отметки')
    assert.equal((await call(teacher1, 'POST', '/api/attendance/bulk', { groupId: 'g1', date: d(7), studentIds: ['s1', 's3'], mark: 'present' })).status, 200)
    const att = (await call(teacher1, 'GET', '/api/bootstrap')).body.attendance
    assert.equal(att[`g1|${d(5)}|s1`], 'absent')
    assert.equal(att[`g1|${d(7)}|s3`], 'present')
    assert.equal((await call(teacher1, 'PUT', '/api/attendance', { ...mark, mark: null })).status, 200, 'снять отметку')
    assert.equal(((await call(teacher1, 'GET', '/api/bootstrap')).body.attendance)[`g1|${d(5)}|s1`], undefined)
    assert.equal((await call(manager, 'PUT', '/api/attendance', { ...mark, mark: 'excused' })).status, 200)
  })

  it('перевод закрывает старую запись и открывает новую', async () => {
    const t = { id: 'tr1', studentId: 's1', fromGroupId: 'g1', toGroupId: 'g2', date: d(15), reason: 'уровень', enrollmentId: 'e3' }
    assert.equal((await call(manager, 'POST', '/api/transfers', t)).status, 200)
    const b = (await call(owner, 'GET', '/api/bootstrap')).body
    const old = b.enrollments.find((e: any) => e.id === 'e1')
    const nw = b.enrollments.find((e: any) => e.id === 'e3')
    assert.equal(old.endDate, d(14))
    assert.equal(nw.startDate, d(15))
    assert.equal(nw.groupId, 'g2')
    assert.equal(b.transfers.length, 1)
    // преподаватель 2 теперь видит и перешедшего ученика; история преподавателя 1 (прошлые записи) остаётся для посещаемости
    assert.deepEqual((await call(teacher2, 'GET', '/api/bootstrap')).body.students.map((s: any) => s.id).sort(), ['s1', 's2'])
  })

  it('запись и снятие с группы, ушедший ученик', async () => {
    assert.equal((await call(manager, 'POST', '/api/enrollments', { id: 'e4', studentId: 's3', groupId: 'g1', startDate: d(10) })).status, 200)
    assert.equal((await call(manager, 'POST', '/api/enrollments', { id: 'e5', studentId: 's3', groupId: 'g1', startDate: d(10) })).status, 200, 'повторная запись игнорируется')
    let b = (await call(owner, 'GET', '/api/bootstrap')).body
    assert.equal(b.enrollments.filter((e: any) => e.studentId === 's3' && e.groupId === 'g1').length, 1)
    assert.equal((await call(manager, 'POST', '/api/enrollments/e4/end', { date: d(5) })).status, 200)
    b = (await call(owner, 'GET', '/api/bootstrap')).body
    assert.equal(b.enrollments.find((e: any) => e.id === 'e4'), undefined, 'дата ухода раньше прихода — запись удалена')
    assert.equal((await call(manager, 'PATCH', '/api/students/s2', { status: 'left', closeOn: d(20) })).status, 200)
    b = (await call(owner, 'GET', '/api/bootstrap')).body
    assert.equal(b.enrollments.find((e: any) => e.id === 'e2').endDate, d(20))
    assert.equal(b.students.find((s: any) => s.id === 's2').status, 'left')
  })

  it('очистка необязательных полей через null', async () => {
    assert.equal((await call(manager, 'PATCH', '/api/students/s1', { note: 'заметка', birthDate: '2010-05-05' })).status, 200)
    assert.equal((await call(owner, 'GET', '/api/bootstrap')).body.students.find((s: any) => s.id === 's1').note, 'заметка')
    assert.equal((await call(manager, 'PATCH', '/api/students/s1', { note: null, birthDate: null })).status, 200)
    const s = (await call(owner, 'GET', '/api/bootstrap')).body.students.find((s: any) => s.id === 's1')
    assert.equal(s.note, undefined)
    assert.equal(s.birthDate, undefined)
  })

  it('фото: загрузка, права на чтение, проверка типа', async () => {
    const put = (who: Who, body: Buffer, type = 'image/png') => call(who, 'PUT', '/api/students/s1/photo', body, { 'content-type': type })
    assert.equal((await put(teacher1, PNG)).status, 403, 'преподаватель не загружает')
    assert.equal((await put(manager, Buffer.from('<script>alert(1)</script>'), 'image/png')).status, 415, 'не изображение')
    assert.equal((await put(manager, Buffer.from('plain text file with some words'), 'text/plain')).status, 415)
    const up = await put(manager, PNG)
    assert.equal(up.status, 200)
    assert.equal(up.body.photoVersion, 1)
    const get = await app.inject({ method: 'GET', url: '/api/students/s1/photo', headers: { cookie: manager.cookie } })
    assert.equal(get.statusCode, 200)
    assert.equal(get.headers['content-type'], 'image/png')
    assert.ok(Buffer.from(get.rawPayload).equals(PNG))
    assert.match(String(get.headers['cache-control']), /immutable/)
    assert.equal((await app.inject({ method: 'GET', url: '/api/students/s1/photo' })).statusCode, 401)
    // s1 сейчас в g2 (преподаватель 2); преподаватель 1 учил его раньше, поэтому историю видит. Посторонний ученик (s3) — нет.
    assert.equal((await app.inject({ method: 'GET', url: '/api/students/s1/photo', headers: { cookie: teacher1.cookie } })).statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/api/students/s3/photo', headers: { cookie: teacher1.cookie } })).statusCode, 403)
    assert.equal((await app.inject({ method: 'GET', url: '/api/students/s1/photo', headers: { cookie: teacher2.cookie } })).statusCode, 200)
    const again = await put(owner, PNG)
    assert.equal(again.body.photoVersion, 2)
    assert.equal((await call(owner, 'GET', '/api/bootstrap')).body.students.find((s: any) => s.id === 's1').photoVersion, 2)
    assert.equal((await call(manager, 'DELETE', '/api/students/s1/photo')).status, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/api/students/s1/photo', headers: { cookie: manager.cookie } })).statusCode, 404)
  })

  it('владелец меняет роль, почту и привязку; защита владельцев', async () => {
    const users = (await call(owner, 'GET', '/api/users')).body
    const mgr = users.find((u: any) => u.email === 'manager@test.uz')
    assert.equal((await call(owner, 'PATCH', `/api/users/${mgr.id}`, {})).status, 400, 'пустое изменение')
    // менеджер → преподаватель (нужен teacherId)
    assert.equal((await call(owner, 'PATCH', `/api/users/${mgr.id}`, { role: 'teacher' })).status, 400)
    const asT = await call(owner, 'PATCH', `/api/users/${mgr.id}`, { role: 'teacher', teacherId: 't1' })
    assert.equal(asT.status, 200)
    assert.equal(asT.body.role, 'teacher')
    assert.equal(asT.body.teacherId, 't1')
    // роль действует сразу, без повторного входа: менеджерские права пропали
    assert.equal((await call(manager, 'GET', '/api/bootstrap')).body.payments.length, 0)
    assert.equal((await call(manager, 'POST', '/api/payments', {})).status, 403)
    // обратно в менеджера, меняем почту
    const back = await call(owner, 'PATCH', `/api/users/${mgr.id}`, { role: 'manager', email: 'Manager2@test.uz' })
    assert.equal(back.body.role, 'manager')
    assert.equal(back.body.teacherId, '')
    assert.equal(back.body.email, 'manager2@test.uz')
    assert.equal((await call(owner, 'PATCH', `/api/users/${mgr.id}`, { email: 'owner@test.uz' })).status, 409, 'почта занята')
    manager = await login('manager2@test.uz', 'manager-pass-1')
    // защита: нельзя понизить себя / последнего владельца
    assert.equal((await call(owner, 'PATCH', '/api/users/u-owner', { role: 'manager' })).status, 400)
    // второй владелец появляется — тогда понижение возможно, но не себя
    const second = await call(owner, 'POST', '/api/users', { email: 'second@test.uz', password: 'second-pass-1', role: 'owner' })
    assert.equal(second.status, 200)
    const owner2 = await login('second@test.uz', 'second-pass-1')
    assert.equal((await call(owner, 'PATCH', `/api/users/${second.body.id}`, { role: 'manager' })).status, 200, 'можно понизить другого владельца')
    assert.equal((await call(owner2, 'GET', '/api/users')).status, 403, 'понижённый сразу теряет права')
    // смена собственного пароля не выкидывает из текущей сессии
    assert.equal((await call(owner, 'PATCH', '/api/users/u-owner', { password: 'owner-pass-2' })).status, 200)
    assert.equal((await call(owner, 'GET', '/api/auth/me')).body.user.role, 'owner')
    owner = await login('owner@test.uz', 'owner-pass-2')
  })

  it('смена пароля завершает старые сессии; нельзя удалить себя', async () => {
    const users = (await call(owner, 'GET', '/api/users')).body
    const t1 = users.find((u: any) => u.email === 't1@test.uz')
    assert.equal((await call(owner, 'PATCH', `/api/users/${t1.id}`, { password: 'new-teacher-pass' })).status, 200)
    assert.equal((await call(teacher1, 'GET', '/api/bootstrap')).status, 401)
    teacher1 = await login('t1@test.uz', 'new-teacher-pass')
    assert.equal((await call(owner, 'DELETE', `/api/users/u-owner`)).status, 400)
  })

  it('удаление преподавателя убирает и его логин', async () => {
    assert.equal((await call(owner, 'DELETE', '/api/teachers/t2')).status, 200)
    assert.equal((await call(teacher2, 'GET', '/api/bootstrap')).status, 401)
  })

  it('импорт полностью заменяет данные и работает «туда-обратно»', async () => {
    const before = (await call(owner, 'GET', '/api/bootstrap')).body
    const r = await call(owner, 'POST', '/api/import', before)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const after = (await call(owner, 'GET', '/api/bootstrap')).body
    for (const k of ['students', 'courses', 'teachers', 'groups', 'enrollments', 'transfers', 'payments', 'leads', 'attendance', 'settings'] as const)
      assert.deepEqual(after[k], before[k], k)
    assert.equal((await call(owner, 'POST', '/api/import', { students: 'oops' })).status, 400)
  })

  it('защита от перебора пароля', async () => {
    let last = 0
    for (let i = 0; i < 7; i++) last = (await call(null, 'POST', '/api/auth/login', { email: 'victim@test.uz', password: `wrong${i}` })).status
    assert.equal(last, 429)
    // верный вход под другим email не блокируется
    assert.equal((await call(null, 'POST', '/api/auth/login', { email: 'owner@test.uz', password: 'owner-pass-2' })).status, 200)
  })

  it('удаление группы каскадно чистит записи и посещаемость', async () => {
    assert.equal((await call(manager, 'DELETE', '/api/groups/g1')).status, 200)
    const b = (await call(owner, 'GET', '/api/bootstrap')).body
    assert.ok(!b.groups.some((g: any) => g.id === 'g1'))
    assert.ok(!b.enrollments.some((e: any) => e.groupId === 'g1'))
    assert.ok(!Object.keys(b.attendance).some((k) => k.startsWith('g1|')))
  })
})
