import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../src/store.ts'

const fresh = () => openStore(':memory:')

test('create thread, reply inherits url, list groups replies under thread', () => {
  const s = fresh()
  const t = s.create({ url: '/qtw-project-manager', author: 'An', body: 'Nút này lệch', selector: 'button.save' })
  assert.equal(t.status, 'open')
  assert.equal(t.by_agent, 0)
  const r = s.create({ parent_id: t.id, author: 'Bình', body: '+1' })
  assert.equal(r.url, '/qtw-project-manager')

  const threads = s.list({ url: '/qtw-project-manager' })
  assert.equal(threads.length, 1)
  assert.equal(threads[0].body, 'Nút này lệch')
  assert.deepEqual(threads[0].replies.map((x) => x.body), ['+1'])
  assert.equal(s.list({ url: '/other' }).length, 0)
})

test('reply to unknown or to a reply is rejected', () => {
  const s = fresh()
  assert.throws(() => s.create({ parent_id: 'nope', author: 'A', body: 'x' }), /parent/)
  const t = s.create({ url: '/', author: 'A', body: 'x' })
  const r = s.create({ parent_id: t.id, author: 'B', body: 'y' })
  assert.throws(() => s.create({ parent_id: r.id, author: 'C', body: 'z' }), /parent/)
})

test('thread without url is rejected', () => {
  assert.throws(() => fresh().create({ author: 'A', body: 'x' }), /url/)
})

test('resolve / reopen only on threads; list filters by status', () => {
  const s = fresh()
  const a = s.create({ url: '/', author: 'A', body: 'a' })
  s.create({ url: '/', author: 'A', body: 'b' })
  const resolved = s.setStatus(a.id, 'resolved')!
  assert.equal(resolved.status, 'resolved')
  assert.ok(resolved.resolved_at)
  assert.deepEqual(s.list({ status: 'open' }).map((t) => t.body), ['b'])
  assert.deepEqual(s.list({ status: 'resolved' }).map((t) => t.body), ['a'])
  assert.equal(s.setStatus(a.id, 'open')!.resolved_at, null)

  const r = s.create({ parent_id: a.id, author: 'B', body: 'reply' })
  assert.equal(s.setStatus(r.id, 'resolved'), undefined)
  assert.equal(s.setStatus('missing', 'resolved'), undefined)
})

test('get returns thread with replies; agent flag is stored', () => {
  const s = fresh()
  const t = s.create({ url: '/', author: 'A', body: 'a' })
  s.create({ parent_id: t.id, author: 'ai', body: 'fixed', by_agent: true })
  const got = s.get(t.id)!
  assert.equal(got.replies[0].by_agent, 1)
  assert.equal(s.get('missing'), undefined)
})

test('file DB is shared between two connections (proxy + MCP processes)', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sp-')), 'nested', 'comments.db')
  const a = openStore(file)
  const b = openStore(file)
  a.create({ url: '/', author: 'A', body: 'from proxy' })
  assert.equal(b.list({})[0].body, 'from proxy')
})

const waitFor = async (cond: () => boolean, ms = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return cond()
}

test('watch fires on own writes immediately (data_version does not change for them)', () => {
  const s = fresh()
  let n = 0
  const stop = s.watch(() => n++)
  const t = s.create({ url: '/', author: 'A', body: 'x' })
  assert.equal(n, 1)
  s.setStatus(t.id, 'resolved')
  assert.equal(n, 2)
  stop()
  s.create({ url: '/', author: 'A', body: 'y' })
  assert.equal(n, 2, 'no calls after stop')
})

test('watch fires when another connection (the MCP process) writes', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sp-')), 'comments.db')
  const proxy = openStore(file)
  const mcp = openStore(file)
  let n = 0
  const stop = proxy.watch(() => n++, 50)
  mcp.create({ url: '/', author: 'AI Agent', body: 'fixed', by_agent: true })
  assert.ok(await waitFor(() => n === 1), 'external write noticed')
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(n, 1, 'fires once per change, not on every tick')
  stop()
})
