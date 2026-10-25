import { AwsClient } from 'aws4fetch'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>
  delete(key: string): Promise<void>
}

/** Cloudflare R2 по S3-совместимому API. Бакет остаётся приватным: фото отдаёт наш сервер после проверки прав. */
export function r2Storage(o: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; endpoint?: string }): Storage {
  const aws = new AwsClient({ accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey, service: 's3', region: 'auto' })
  const base = (o.endpoint ?? `https://${o.accountId}.r2.cloudflarestorage.com`).replace(/\/$/, '')
  const url = (key: string) => `${base}/${o.bucket}/${key}`
  return {
    async put(key, body, contentType) {
      const res = await aws.fetch(url(key), { method: 'PUT', body: new Uint8Array(body), headers: { 'content-type': contentType } })
      if (!res.ok) throw new Error(`R2 put failed: ${res.status}`)
    },
    async get(key) {
      const res = await aws.fetch(url(key))
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`R2 get failed: ${res.status}`)
      return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'application/octet-stream' }
    },
    async delete(key) {
      const res = await aws.fetch(url(key), { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error(`R2 delete failed: ${res.status}`)
    },
  }
}

/** Папка на диске — для разработки и тестов без R2 */
export function localStorage(dir: string): Storage {
  const file = (key: string) => path.join(dir, key.replace(/[^A-Za-z0-9._/-]/g, '_'))
  return {
    async put(key, body, contentType) {
      await mkdir(path.dirname(file(key)), { recursive: true })
      await writeFile(file(key), body)
      await writeFile(file(key) + '.type', contentType)
    },
    async get(key) {
      try {
        return { body: await readFile(file(key)), contentType: (await readFile(file(key) + '.type', 'utf8')).trim() }
      } catch {
        return null
      }
    },
    async delete(key) {
      await rm(file(key), { force: true })
      await rm(file(key) + '.type', { force: true })
    },
  }
}

export function storageFromEnv(env: NodeJS.ProcessEnv): { storage: Storage; driver: 'r2' | 'local' } {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env
  if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET) {
    return { driver: 'r2', storage: r2Storage({ accountId: R2_ACCOUNT_ID, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, bucket: R2_BUCKET, endpoint: env.R2_ENDPOINT }) }
  }
  return { driver: 'local', storage: localStorage(env.UPLOADS_DIR ?? './data/uploads') }
}

/** Проверка по первым байтам, а не по заголовку Content-Type, который можно подделать */
export function sniffImage(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}
