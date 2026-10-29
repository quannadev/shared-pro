import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { createProxy } from '../src/server.ts'
import { openStore } from '../src/store.ts'

const SCRIPT = '<script type="module" src="/__sp/widget.js"></script>'
let upstream: http.Server, proxy: http.Server, base: string
const seen: http.IncomingHttpHeaders[] = []

before(async () => {
  upstream = http.createServer((req, res) => {
    seen.push(req.headers)
    if (req.url === '/page') {
      const html = '<html><body>hi</body></html>'
      if (/gzip/.test(req.headers['accept-encoding'] ?? '')) {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
        return res.end(zlib.gzipSync(html))
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) })
      return res.end(html)
    }
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.write('<html><body>part1')
      return setTimeout(() => res.end('part2</body></html>'), 50)
    }
    if (req.url === '/api') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"ok":true}')
    }
    res.writeHead(404).end()
  })
  upstream.on('upgrade', (req, socket) => {
    seen.push(req.headers)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (d) => socket.write(d)) // echo
    socket.on('end', () => socket.end()) // like a real WS server: close when the peer does
  })
  await new Promise<void>((r) => upstream.listen(0, r))
  proxy = createProxy({ target: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, store: openStore(':memory:') })
  await new Promise<void>((r) => proxy.listen(0, r))
  base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
})

// fetch() forbids setting Origin/Host, so speak raw HTTP; resolves on first response bytes.
function rawGet(path: string, headers: string) {
  const { port } = proxy.address() as AddressInfo
  return new Promise<void>((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${path} HTTP/1.1\r\n${headers}\r\n\r\n`))
    s.once('data', () => (s.destroy(), resolve()))
  })
}

after(() => {
  proxy.close()
  upstream.close()
  proxy.closeAllConnections()
  upstream.closeAllConnections()
})

test('injects widget script into HTML and drops content-length', async () => {
  const res = await fetch(`${base}/page`)
  const body = await res.text()
  assert.ok(body.endsWith(SCRIPT), body)
  assert.ok(body.startsWith('<html><body>hi'))
})

test('upstream that gzips on request still gets injected (accept-encoding stripped)', async () => {
  const res = await fetch(`${base}/page`, { headers: { 'accept-encoding': 'gzip, br' } })
  assert.ok((await res.text()).endsWith(SCRIPT))
})

test('streaming HTML is passed through and injected at the end', async () => {
  const body = await (await fetch(`${base}/stream`)).text()
  assert.equal(body, `<html><body>part1part2</body></html>${SCRIPT}`)
})

test('non-HTML responses are untouched', async () => {
  assert.equal(await (await fetch(`${base}/api`)).text(), '{"ok":true}')
})

test('HEAD on HTML gets no body', async () => {
  const res = await fetch(`${base}/page`, { method: 'HEAD' })
  assert.equal(res.status, 200)
  assert.equal(await res.text(), '')
})

test('Host header is rewritten to the target', async () => {
  seen.length = 0
  await fetch(`${base}/api`, { headers: { host: 'abc.trycloudflare.com' } })
  assert.match(seen[0].host!, /^127\.0\.0\.1:\d+$/)
})

test('same-origin Origin is rewritten to the target (Next.js dev cross-origin guard)', async () => {
  seen.length = 0
  const { port } = upstream.address() as AddressInfo
  await rawGet('/api', 'Host: abc.trycloudflare.com\r\nOrigin: https://abc.trycloudflare.com')
  assert.equal(seen[0].origin, `http://127.0.0.1:${port}`)
})

test('foreign Origin is passed through untouched so upstream can still block it', async () => {
  seen.length = 0
  await rawGet('/api', 'Host: localhost:3100\r\nOrigin: https://evil.example')
  assert.equal(seen[0].origin, 'https://evil.example')
})

test('websocket upgrade also rewrites same-origin Origin', async () => {
  seen.length = 0
  const { port } = upstream.address() as AddressInfo
  await rawGet('/hmr', 'Host: abc.trycloudflare.com\r\nOrigin: https://abc.trycloudflare.com\r\nUpgrade: websocket\r\nConnection: Upgrade')
  assert.equal(seen[0].origin, `http://127.0.0.1:${port}`)
})

test('widget is served by the proxy, not forwarded', async () => {
  seen.length = 0
  const res = await fetch(`${base}/__sp/widget.js`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type')!, /javascript/)
  assert.match(await res.text(), /export function cssPath/)
  assert.equal(seen.length, 0)
})

test('websocket upgrade is tunnelled both ways', async () => {
  const { port } = proxy.address() as AddressInfo
  const sock = net.connect(port, '127.0.0.1')
  sock.write('GET /hmr HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  let buf = ''
  await new Promise<void>((resolve) => {
    sock.on('data', (d) => {
      buf += d
      if (buf.includes('\r\n\r\n') && !buf.includes('ping')) sock.write('ping')
      if (buf.includes('ping')) resolve()
    })
  })
  sock.destroy()
  assert.match(buf, /^HTTP\/1.1 101/)
})
