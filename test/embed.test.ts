import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createProxy } from '../src/server.ts'
import { openStore } from '../src/store.ts'

// Embed mode: the reviewed site adds <script type="module" src="https://<server>/__sp/widget.js">. The server proxies
// nothing; it serves the widget + API cross-origin to an allowlist of site origins, auth via an x-sp-token header
// (third-party cookies are blocked by browsers).
const TOKEN = 'embed-token'
const SITE = 'https://staging.example.com'
let server: http.Server, base: string

before(async () => {
  server = createProxy({ store: openStore(':memory:'), token: TOKEN, origins: [SITE] })
  await new Promise<void>((r) => server.listen(0, r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => (server.close(), server.closeAllConnections()))

const fromSite = (extra: Record<string, string> = {}, origin = SITE) => ({ origin, ...extra })

test('no target: pages are not proxied', async () => {
  const res = await fetch(`${base}/some/page`)
  assert.equal(res.status, 404)
  assert.match(await res.text(), /embed/)
})

test('preflight from an allowed site origin is answered for the widget headers and methods', async () => {
  const res = await fetch(`${base}/__sp/api/comments`, {
    method: 'OPTIONS',
    headers: fromSite({ 'access-control-request-method': 'DELETE', 'access-control-request-headers': 'content-type,x-sp-token,x-sp-client' }),
  })
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('access-control-allow-origin'), SITE)
  for (const m of ['GET', 'POST', 'PATCH', 'DELETE']) assert.match(res.headers.get('access-control-allow-methods')!, new RegExp(m))
  for (const h of ['content-type', 'x-sp-token', 'x-sp-client']) assert.match(res.headers.get('access-control-allow-headers')!, new RegExp(h))
  assert.match(res.headers.get('vary') ?? '', /origin/i)
  assert.equal(res.headers.get('access-control-allow-credentials'), null, 'no cookies cross-site')
})

test('other origins get no CORS headers (preflight refused, responses unreadable)', async () => {
  const pre = await fetch(`${base}/__sp/api/comments`, { method: 'OPTIONS', headers: fromSite({ 'access-control-request-method': 'GET' }, 'https://evil.example') })
  assert.equal(pre.status, 403)
  assert.equal(pre.headers.get('access-control-allow-origin'), null)
  const get = await fetch(`${base}/__sp/api/comments`, { headers: fromSite({ 'x-sp-token': TOKEN }, 'https://evil.example') })
  assert.equal(get.headers.get('access-control-allow-origin'), null)
})

test('widget and screenshot library are served with CORS (module scripts load in CORS mode)', async () => {
  for (const path of ['/__sp/widget.js', '/__sp/vendor/modern-screenshot.js']) {
    const res = await fetch(`${base}${path}`, { headers: fromSite() })
    assert.equal(res.status, 200, path)
    assert.equal(res.headers.get('access-control-allow-origin'), SITE, path)
  }
})

test('API authenticates with the x-sp-token header (no cookie) and answers with CORS', async () => {
  assert.equal((await fetch(`${base}/__sp/api/comments`, { headers: fromSite() })).status, 401)
  assert.equal((await fetch(`${base}/__sp/api/comments`, { headers: fromSite({ 'x-sp-token': 'wrong' }) })).status, 401)
  const created = await fetch(`${base}/__sp/api/comments`, {
    method: 'POST',
    headers: fromSite({ 'x-sp-token': TOKEN, 'x-sp-client': '0123456789abcdef0123456789abcdef', 'content-type': 'application/json' }),
    body: JSON.stringify({ url: '/dashboard', author: 'QA', body: 'from the staging site' }),
  })
  assert.equal(created.status, 201)
  assert.equal(created.headers.get('access-control-allow-origin'), SITE)
  assert.equal((await created.json()).mine, true)
  const list = await (await fetch(`${base}/__sp/api/comments?url=/dashboard`, { headers: fromSite({ 'x-sp-token': TOKEN }) })).json()
  assert.equal(list.threads[0].body, 'from the staging site')
})

test('every /__sp response varies on Origin, so a copy cached for one origin is never reused for another', async () => {
  // Found in the browser: the screenshot library cached from a same-origin (no Origin) load had no CORS header and
  // was reused for the embedding site, which then blocked it for a day (max-age=86400).
  for (const path of ['/__sp/vendor/modern-screenshot.js', '/__sp/widget.js', '/__sp/api/comments']) {
    const res = await fetch(`${base}${path}`)
    assert.match(res.headers.get('vary') ?? '', /origin/i, path)
  }
})
