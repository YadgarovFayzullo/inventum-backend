import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { r2Storage, sniffImage } from './storage'

describe('R2 storage', () => {
  it('подписывает запросы AWS SigV4 и использует путь /bucket/key', async () => {
    const seen: { method: string; url: string; auth?: string; type?: string; body: Buffer }[] = []
    const files = new Map<string, Buffer>()
    const srv = createServer(async (req: IncomingMessage, res) => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const body = Buffer.concat(chunks)
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, type: req.headers['content-type'], body })
      if (req.method === 'PUT') { files.set(req.url!, body); res.writeHead(200).end() }
      else if (req.method === 'GET') { const f = files.get(req.url!); f ? res.writeHead(200, { 'content-type': 'image/webp' }).end(f) : res.writeHead(404).end() }
      else if (req.method === 'DELETE') { files.delete(req.url!); res.writeHead(204).end() }
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const endpoint = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
    try {
      const st = r2Storage({ accountId: 'acc', accessKeyId: 'AKID', secretAccessKey: 'secret', bucket: 'photos', endpoint })
      const data = Buffer.from('RIFFxxxxWEBPdata')
      await st.put('students/s1/1', data, 'image/webp')
      assert.match(seen[0]!.auth ?? '', /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request/)
      assert.equal(seen[0]!.url, '/photos/students/s1/1')
      assert.equal(seen[0]!.type, 'image/webp')
      assert.ok(seen[0]!.body.equals(data))
      const got = await st.get('students/s1/1')
      assert.ok(got && got.body.equals(data) && got.contentType === 'image/webp')
      await st.delete('students/s1/1')
      assert.equal(await st.get('students/s1/1'), null)
    } finally {
      srv.close()
    }
  })

  it('sniffImage различает форматы по содержимому', () => {
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg')
    assert.equal(sniffImage(Buffer.from('89504e470d0a1a0a0000000d', 'hex')), 'image/png')
    assert.equal(sniffImage(Buffer.from('RIFF1234WEBPVP8 ')), 'image/webp')
    assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null)
    assert.equal(sniffImage(Buffer.from('GIF89a......')), null)
  })
})
