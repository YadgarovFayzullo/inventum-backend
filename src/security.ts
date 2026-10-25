import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { Sql } from './db'

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>
const PARAMS = { N: 16384, r: 8, p: 1 }

/** scrypt$N$salt$hash — параметры внутри строки, чтобы позже можно было усилить */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, 64, PARAMS)
  return `scrypt$${PARAMS.N}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, salt, hash] = stored.split('$')
  if (alg !== 'scrypt' || !n || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { ...PARAMS, N: Number(n) })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// Фиктивный хэш: проверяем пароль даже если email не найден, чтобы по времени ответа нельзя было узнать, есть ли такой пользователь
export const DUMMY_HASH = await hashPassword('dummy-password-for-timing')

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export const SESSION_COOKIE = 'inv_session'
export const REMEMBER_MS = 30 * 24 * 3600 * 1000
export const SHORT_MS = 12 * 3600 * 1000

export async function createSession(sql: Sql, userId: string, remember: boolean) {
  const token = randomBytes(32).toString('base64url')
  const ttl = remember ? REMEMBER_MS : SHORT_MS
  await sql`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${sha256(token)}, ${userId}, ${Date.now() + ttl})`
  return { token, ttl }
}

export type SessionUser = { id: string; email: string; role: 'owner' | 'manager' | 'teacher'; name: string; teacherId: string }

export async function findSession(sql: Sql, token: string): Promise<SessionUser | null> {
  const [row] = await sql<(Omit<SessionUser, 'teacherId'> & { teacherId: string | null; exp: number })[]>`
    SELECT u.id, u.email, u.role, u.name, u.teacher_id AS "teacherId", s.expires_at AS exp
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ${sha256(token)}`
  if (!row) return null
  if (row.exp < Date.now()) {
    await destroySession(sql, token)
    return null
  }
  return { id: row.id, email: row.email, role: row.role, name: row.name, teacherId: row.teacherId ?? '' }
}

/** Завершить все сессии пользователя, кроме текущей (нужна, когда владелец меняет собственный пароль) */
export async function destroyOtherSessions(sql: Sql, userId: string, keepToken: string | null) {
  await sql`DELETE FROM sessions WHERE user_id = ${userId} AND token_hash <> ${keepToken ? sha256(keepToken) : ''}`
}

export async function destroySession(sql: Sql, token: string) {
  await sql`DELETE FROM sessions WHERE token_hash = ${sha256(token)}`
}

export async function purgeExpiredSessions(sql: Sql) {
  await sql`DELETE FROM sessions WHERE expires_at < ${Date.now()}`
}

/** Ограничение перебора пароля: 5 неудач на пару IP+email за 15 минут, плюс общий лимит на IP */
export class LoginLimiter {
  private hits = new Map<string, { n: number; until: number }>()
  constructor(private max = 5, private windowMs = 15 * 60 * 1000, private ipMax = 30) {}

  private keys(ip: string, email: string) {
    return [`${ip}|${email}`, ip]
  }
  blocked(ip: string, email: string) {
    const now = Date.now()
    const [pair, ipKey] = this.keys(ip, email)
    const a = this.hits.get(pair!)
    const b = this.hits.get(ipKey!)
    return (!!a && a.until > now && a.n >= this.max) || (!!b && b.until > now && b.n >= this.ipMax)
  }
  fail(ip: string, email: string) {
    const now = Date.now()
    for (const k of this.keys(ip, email)) {
      const cur = this.hits.get(k)
      this.hits.set(k, cur && cur.until > now ? { n: cur.n + 1, until: cur.until } : { n: 1, until: now + this.windowMs })
    }
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.until < now) this.hits.delete(k)
  }
  reset(ip: string, email: string) {
    this.hits.delete(`${ip}|${email}`)
  }
}
