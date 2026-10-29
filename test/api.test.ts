import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createProxy } from '../src/server.ts'
import { openStore } from '../src/store.ts'

const TOKEN = 'secret-token'
let upstream: http.Server, proxy: http.Server, base: string
const store = openStore(':memory:')
const upstreamHits: string[] = []
const auth = { cookie: `sp_token=${TOKEN}` }
const json = { ...auth, 'content-type': 'application/json' }
const post = (body: unknown, headers: Record<string, string> = json) =>
  fetch(`${base}/__sp/api/comments`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })

before(async () => {
  upstream = http.createServer((req, res) => {
    upstreamHits.push(req.url!)
    if (req.url!.startsWith('/with-cookie')) res.setHeader('set-cookie', 'app_session=1; Path=/')
    res.end('app')
  })
  await new Promise<void>((r) => upstream.listen(0, r))
  proxy = createProxy({
    target: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    store,
    token: TOKEN,
  })
  await new Promise<void>((r) => proxy.listen(0, r))
  base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
})

after(() => {
  proxy.close()
  upstream.close()
  proxy.closeAllConnections()
  upstream.closeAllConnections()
})

// The share link stays in the address bar (no redirect): copying the URL or "Open in Safari" from an
// in-app browser still carries the token into the next browser.
test('?sp=TOKEN: no redirect, the app page is served with our cookie and the URL is forwarded unchanged', async () => {
  upstreamHits.length = 0
  const res = await fetch(`${base}/qtw-project-manager/tasks?sp=${TOKEN}&tab=2`, { redirect: 'manual' })
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'app')
  assert.match(res.headers.get('set-cookie')!, new RegExp(`^sp_token=${TOKEN};.*HttpOnly.*Secure.*SameSite=Lax`))
  // unchanged, so server-rendered and client-side search params stay identical (no hydration mismatch)
  assert.deepEqual(upstreamHits, [`/qtw-project-manager/tasks?sp=${TOKEN}&tab=2`])
})

test('?sp=TOKEN keeps the app’s own Set-Cookie headers next to ours', async () => {
  const res = await fetch(`${base}/with-cookie?sp=${TOKEN}`)
  const cookies = res.headers.getSetCookie()
  assert.ok(cookies.some((c) => c.startsWith('app_session=1')), cookies.join(' | '))
  assert.ok(cookies.some((c) => c.startsWith(`sp_token=${TOKEN}`)), cookies.join(' | '))
})

test('wrong ?sp= token: page still served, no cookie', async () => {
  const res = await fetch(`${base}/?sp=wrong`, { redirect: 'manual' })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('set-cookie'), null)
})

test('cookie from the share link unlocks the API', async () => {
  const res = await fetch(`${base}/x?sp=${TOKEN}`)
  const cookie = res.headers.getSetCookie()[0].split(';')[0]
  assert.equal((await fetch(`${base}/__sp/api/comments?url=/`, { headers: { cookie } })).status, 200)
})

test('API without the token cookie is 401, app itself still proxies', async () => {
  assert.equal((await fetch(`${base}/__sp/api/comments?url=/`)).status, 401)
  assert.equal((await fetch(`${base}/__sp/api/comments?url=/`, { headers: { cookie: 'sp_token=nope' } })).status, 401)
  assert.equal(await (await fetch(`${base}/some/page`)).text(), 'app')
})

test('create thread + reply, list by url', async () => {
  const created = await post({ url: '/p', author: ' An ', body: 'Sai màu', selector: '#save', pos_x: 50, pos_y: 10 })
  assert.equal(created.status, 201)
  const t = await created.json()
  assert.equal(t.author, 'An')

  assert.equal((await post({ parent_id: t.id, author: 'Bình', body: 'đồng ý' })).status, 201)

  const list = await (await fetch(`${base}/__sp/api/comments?url=/p`, { headers: auth })).json()
  assert.equal(list.threads.length, 1)
  assert.equal(list.threads[0].replies[0].body, 'đồng ý')

  const open = await (await fetch(`${base}/__sp/api/comments?url=/p&status=open`, { headers: auth })).json()
  assert.equal(open.threads.length, 1)
})

const patch = (id: string, body: unknown) =>
  fetch(`${base}/__sp/api/comments/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify(body) })

test('only the AI agent resolves: reviewers get 403 on PATCH resolved, thread stays open', async () => {
  const t = await (await post({ url: '/p', author: 'A', body: 'x' })).json()
  const res = await patch(t.id, { status: 'resolved' })
  assert.equal(res.status, 403)
  assert.match((await res.json()).error, /AI agent/)
  assert.equal(store.get(t.id)!.status, 'open')
})

test('reviewers can reopen a thread the agent resolved (safety valve)', async () => {
  const t = await (await post({ url: '/p', author: 'A', body: 'x' })).json()
  store.setStatus(t.id, 'resolved') // what the MCP resolve_comment tool does
  const res = await patch(t.id, { status: 'open' })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).status, 'open')
})

test('reviewers cannot impersonate the agent', async () => {
  const t = await (await post({ url: '/p', author: 'ai', body: 'x', by_agent: true })).json()
  assert.equal(t.by_agent, 0)
})

test('validation errors are 400 with a message', async () => {
  const cases: unknown[] = [
    { url: '/p', author: '', body: 'x' },
    { url: '/p', author: 'A', body: '   ' },
    { url: '/p', author: 'A', body: 'x'.repeat(5001) },
    { url: 'https://evil/p', author: 'A', body: 'x' },
    { author: 'A', body: 'x' },
    { url: '/p', author: 'A', body: 'x', pos_x: 'left' },
    { url: '/p', author: 'A', body: 'x', pos_y: 200 },
    { url: '/p', author: 'A', body: 'x', selector: 42 },
    { parent_id: 'missing', author: 'A', body: 'x' },
    [],
  ]
  for (const c of cases) {
    const res = await post(c)
    assert.equal(res.status, 400, JSON.stringify(c).slice(0, 80))
    assert.ok((await res.json()).error)
  }
  assert.equal((await post('{not json')).status, 400)
})

test('PATCH rejects bad status and unknown id', async () => {
  const t = await (await post({ url: '/p', author: 'A', body: 'x' })).json()
  assert.equal((await patch(t.id, { status: 'done' })).status, 400)
  assert.equal((await patch('missing', { status: 'open' })).status, 404)
})

test('non-JSON body is 415, oversized body is 413', async () => {
  assert.equal((await post('a=b', { ...auth, 'content-type': 'application/x-www-form-urlencoded' })).status, 415)
  assert.equal((await post({ url: '/p', author: 'A', body: 'x'.repeat(70_000) })).status, 413)
})

test('unknown API route is 404 and /__sp/ never reaches the app', async () => {
  upstreamHits.length = 0
  assert.equal((await fetch(`${base}/__sp/api/nope`, { headers: auth })).status, 404)
  assert.deepEqual(upstreamHits, [])
})

// Long-poll instead of SSE: Cloudflare Quick Tunnels buffer SSE (documented), plain responses pass through.
const changes = (qs: string, headers: Record<string, string> = auth) => fetch(`${base}/__sp/api/changes?${qs}`, { headers })

test('GET /__sp/api/changes needs the token and a numeric since', async () => {
  assert.equal((await changes('since=0', {})).status, 401)
  assert.equal((await changes('since=abc')).status, 400)
})

test('changes: a stale `since` answers at once with the current version', async () => {
  const { version } = await (await changes('since=-1')).json()
  assert.equal(typeof version, 'number')
  const t0 = Date.now()
  const res = await changes(`since=${version - 1}`)
  assert.equal((await res.json()).version, version)
  assert.ok(Date.now() - t0 < 200)
})

test('changes: a current `since` is held until a write, then answers immediately', async () => {
  const { version } = await (await changes('since=-1')).json()
  const held = changes(`since=${version}`)
  await new Promise((r) => setTimeout(r, 150)) // the request is now waiting on the server
  const t0 = Date.now()
  await post({ url: '/p', author: 'A', body: 'wake up' })
  const res = await held
  assert.equal((await res.json()).version, version + 1)
  assert.ok(Date.now() - t0 < 300, `woke in ${Date.now() - t0}ms`)
  assert.equal(res.headers.get('cache-control'), 'no-store')
})

test('changes: a held request times out with the same version (client just asks again)', async () => {
  const { version } = await (await changes('since=-1')).json()
  const t0 = Date.now()
  const res = await changes(`since=${version}&wait=200`)
  assert.equal((await res.json()).version, version)
  assert.ok(Date.now() - t0 >= 180, 'was actually held')
})

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 7)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50, 1)])
const upload = (id: string, body: Buffer, type = 'image/jpeg', headers: Record<string, string> = auth) =>
  fetch(`${base}/__sp/api/comments/${id}/screenshot`, { method: 'POST', headers: { ...headers, 'content-type': type }, body })

test('screenshot upload: stored once, served back as an image, flagged on the thread', async () => {
  const t = await (await post({ url: '/p', author: 'A', body: 'x' })).json()
  assert.equal((await upload(t.id, JPEG)).status, 201)

  const img = await fetch(`${base}/__sp/api/comments/${t.id}/screenshot`, { headers: auth })
  assert.equal(img.status, 200)
  assert.equal(img.headers.get('content-type'), 'image/jpeg')
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), JPEG)
  assert.equal(store.get(t.id)!.screenshot, 'image/jpeg')

  assert.equal((await upload(t.id, JPEG)).status, 409, 'nobody can overwrite it later')
})

test('screenshot upload accepts PNG too', async () => {
  const t = await (await post({ url: '/p', author: 'A', body: 'x' })).json()
  assert.equal((await upload(t.id, PNG, 'image/png')).status, 201)
  assert.equal(store.get(t.id)!.screenshot, 'image/png')
})

test('screenshot upload is validated at the boundary', async () => {
  const t = await (await post({ url: '/p', author: 'A', body: 'x' })).json()
  const r = await (await post({ parent_id: t.id, author: 'B', body: 'reply' })).json()
  assert.equal((await upload(t.id, JPEG, 'image/jpeg', {})).status, 401)
  assert.equal((await upload(t.id, Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml')).status, 415)
  assert.equal((await upload(t.id, Buffer.from('<html>not an image</html>'), 'image/jpeg')).status, 400, 'magic bytes checked')
  assert.equal((await upload(t.id, Buffer.concat([JPEG, Buffer.alloc(3 * 1024 * 1024)]))).status, 413)
  assert.equal((await upload('missing', JPEG)).status, 404)
  assert.equal((await upload(r.id, JPEG)).status, 404, 'only on the thread, not on replies')
  assert.equal((await fetch(`${base}/__sp/api/comments/${r.id}/screenshot`, { headers: auth })).status, 404)
})

test('area comments: area_w/area_h accepted as percentages, validated like pos_x/pos_y', async () => {
  const ok = await post({ url: '/p', author: 'A', body: 'vùng này', pos_x: 5, pos_y: 5, area_w: 40, area_h: 25 })
  assert.equal(ok.status, 201)
  const t = await ok.json()
  assert.equal(t.area_w, 40)
  assert.equal(t.area_h, 25)
  assert.equal((await post({ url: '/p', author: 'A', body: 'x', area_w: 120 })).status, 400)
  assert.equal((await post({ url: '/p', author: 'A', body: 'x', area_h: 'big' })).status, 400)
})

// Delete: no accounts, so ownership is a random per-browser key (x-sp-client). Only its hash is stored.
const me = '0123456789abcdef0123456789abcdef'
const other = 'fedcba9876543210fedcba9876543210'
const as = (client: string) => ({ ...json, 'x-sp-client': client })
const del = (id: string, client?: string) =>
  fetch(`${base}/__sp/api/comments/${id}`, { method: 'DELETE', headers: client ? as(client) : auth })

test('delete: only the browser that wrote a comment can delete it; others get 403', async () => {
  const t = await (await post({ url: '/del', author: 'A', body: 'của tôi' }, as(me))).json()
  assert.equal(t.mine, true)
  assert.equal(t.owner, undefined, 'owner hash never leaves the server')

  assert.equal((await del(t.id, other)).status, 403)
  assert.equal((await del(t.id)).status, 403, 'no key, no delete')
  assert.ok(store.get(t.id))

  assert.equal((await del(t.id, me)).status, 204)
  assert.equal(store.get(t.id), undefined)
  assert.equal((await del(t.id, me)).status, 404)
})

test('delete: own reply only; agent replies (no owner) cannot be deleted from the browser', async () => {
  const t = await (await post({ url: '/del', author: 'A', body: 'thread' }, as(other))).json()
  const mine = await (await post({ parent_id: t.id, author: 'B', body: 'reply của tôi' }, as(me))).json()
  const agent = store.create({ parent_id: t.id, author: 'AI Agent', body: 'fixed', by_agent: true })

  assert.equal((await del(mine.id, me)).status, 204)
  assert.equal((await del(agent.id, me)).status, 403)
  assert.deepEqual(store.get(t.id)!.replies.map((r) => r.body), ['fixed'])
})

test('list marks `mine` per caller and never exposes owner hashes', async () => {
  const t = await (await post({ url: '/mine', author: 'A', body: 'x' }, as(me))).json()
  await post({ parent_id: t.id, author: 'B', body: 'y' }, as(other))
  const view = async (client: string) => (await (await fetch(`${base}/__sp/api/comments?url=/mine`, { headers: as(client) })).json()).threads[0]
  const mineView = await view(me)
  assert.equal(mineView.mine, true)
  assert.equal(mineView.replies[0].mine, false)
  assert.equal((await view(other)).replies[0].mine, true)
  assert.doesNotMatch(JSON.stringify(mineView), /"owner"/)
})

test('a malformed x-sp-client is ignored (comment has no owner)', async () => {
  const t = await (await post({ url: '/mine', author: 'A', body: 'x' }, as('not-a-key'))).json()
  assert.equal(t.mine, false)
  assert.equal(store.owner(t.id), null)
})

test('screenshot upload: only the thread author’s browser may attach it', async () => {
  const t = await (await post({ url: '/del', author: 'A', body: 'x' }, as(me))).json()
  assert.equal((await upload(t.id, JPEG, 'image/jpeg', as(other))).status, 403)
  assert.equal((await upload(t.id, JPEG, 'image/jpeg', as(me))).status, 201)
})
