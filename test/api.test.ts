import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createProxy } from '../src/server.ts'
import { openStore } from '../src/store.ts'

const TOKEN = 'secret-token'
let upstream: http.Server, proxy: http.Server, base: string
const upstreamHits: string[] = []
const auth = { cookie: `sp_token=${TOKEN}` }
const json = { ...auth, 'content-type': 'application/json' }
const post = (body: unknown, headers: Record<string, string> = json) =>
  fetch(`${base}/__sp/api/comments`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })

before(async () => {
  upstream = http.createServer((req, res) => (upstreamHits.push(req.url!), res.end('app')))
  await new Promise<void>((r) => upstream.listen(0, r))
  proxy = createProxy({
    target: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    store: openStore(':memory:'),
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

test('?sp=TOKEN sets an HttpOnly cookie and redirects without the param', async () => {
  const res = await fetch(`${base}/qtw-project-manager/tasks?sp=${TOKEN}&tab=2`, { redirect: 'manual' })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/qtw-project-manager/tasks?tab=2')
  assert.match(res.headers.get('set-cookie')!, new RegExp(`^sp_token=${TOKEN};.*HttpOnly.*SameSite=Lax`))
})

test('wrong ?sp= token sets no cookie', async () => {
  const res = await fetch(`${base}/?sp=wrong`, { redirect: 'manual' })
  assert.equal(res.headers.get('set-cookie'), null)
})

test('API without the token cookie is 401, app itself still proxies', async () => {
  assert.equal((await fetch(`${base}/__sp/api/comments?url=/`)).status, 401)
  assert.equal((await fetch(`${base}/__sp/api/comments?url=/`, { headers: { cookie: 'sp_token=nope' } })).status, 401)
  assert.equal(await (await fetch(`${base}/some/page`)).text(), 'app')
})

test('create thread + reply, list by url, resolve via PATCH', async () => {
  const created = await post({ url: '/p', author: ' An ', body: 'Sai màu', selector: '#save', pos_x: 50, pos_y: 10 })
  assert.equal(created.status, 201)
  const t = await created.json()
  assert.equal(t.author, 'An')

  assert.equal((await post({ parent_id: t.id, author: 'Bình', body: 'đồng ý' })).status, 201)

  const list = await (await fetch(`${base}/__sp/api/comments?url=/p`, { headers: auth })).json()
  assert.equal(list.threads.length, 1)
  assert.equal(list.threads[0].replies[0].body, 'đồng ý')

  const patched = await fetch(`${base}/__sp/api/comments/${t.id}`, {
    method: 'PATCH',
    headers: json,
    body: JSON.stringify({ status: 'resolved' }),
  })
  assert.equal(patched.status, 200)
  assert.equal((await patched.json()).status, 'resolved')

  const open = await (await fetch(`${base}/__sp/api/comments?url=/p&status=open`, { headers: auth })).json()
  assert.equal(open.threads.length, 0)
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
  const patch = (id: string, body: unknown) =>
    fetch(`${base}/__sp/api/comments/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify(body) })
  assert.equal((await patch(t.id, { status: 'done' })).status, 400)
  assert.equal((await patch('missing', { status: 'resolved' })).status, 404)
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
