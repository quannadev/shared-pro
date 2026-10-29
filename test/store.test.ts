import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
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

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

test('screenshots: saved next to the DB, flagged on the thread, readable back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-'))
  const s = openStore(join(dir, 'comments.db'))
  const t = s.create({ url: '/', author: 'A', body: 'x' })
  assert.equal(t.screenshot, null)
  s.saveScreenshot(t.id, JPEG, 'image/jpeg')
  assert.equal(s.get(t.id)!.screenshot, 'image/jpeg')
  const shot = s.screenshot(t.id)!
  assert.deepEqual(shot.data, JPEG)
  assert.equal(shot.type, 'image/jpeg')
  assert.ok(existsSync(join(dir, 'shots', `${t.id}.jpg`)))
  assert.equal(s.screenshot('missing'), undefined)
})

test('screenshots work for :memory: stores too (temp dir)', () => {
  const s = fresh()
  const t = s.create({ url: '/', author: 'A', body: 'x' })
  s.saveScreenshot(t.id, JPEG, 'image/jpeg')
  assert.deepEqual(s.screenshot(t.id)!.data, JPEG)
})

test('an existing DB from an older version gets the screenshot column, rows intact', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sp-')), 'comments.db')
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE comments (id TEXT PRIMARY KEY, parent_id TEXT, url TEXT NOT NULL, selector TEXT, text_snippet TEXT,
    html_snippet TEXT, source_hint TEXT, pos_x REAL, pos_y REAL, viewport TEXT, author TEXT NOT NULL, body TEXT NOT NULL,
    by_agent INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, resolved_at TEXT);
    INSERT INTO comments (id, url, author, body, created_at) VALUES ('old1', '/', 'A', 'kept', '2026-01-01');`)
  old.close()
  const s = openStore(file)
  assert.equal(s.get('old1')!.body, 'kept')
  assert.equal(s.get('old1')!.screenshot, null)
  assert.equal(s.get('old1')!.area_w, null)
  s.saveScreenshot('old1', JPEG, 'image/jpeg')
  assert.equal(s.get('old1')!.screenshot, 'image/jpeg')
})

test('area comments: area_w/area_h stored; older DBs gain the columns', () => {
  const s = fresh()
  const t = s.create({ url: '/', author: 'A', body: 'khoảng trắng', pos_x: 10, pos_y: 20, area_w: 50, area_h: 30 })
  assert.equal(s.get(t.id)!.area_w, 50)
  assert.equal(s.get(t.id)!.area_h, 30)
  assert.equal(s.create({ url: '/', author: 'A', body: 'element' }).area_w, null)
})

test('several processes opening (and migrating) the same old DB at once all succeed', async () => {
  const { spawn } = await import('node:child_process')
  const file = join(mkdtempSync(join(tmpdir(), 'sp-')), 'comments.db')
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE comments (id TEXT PRIMARY KEY, parent_id TEXT, url TEXT NOT NULL, selector TEXT, text_snippet TEXT,
    html_snippet TEXT, source_hint TEXT, pos_x REAL, pos_y REAL, viewport TEXT, author TEXT NOT NULL, body TEXT NOT NULL,
    by_agent INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, resolved_at TEXT)`)
  old.close()
  const store = join(import.meta.dirname, '..', 'src', 'store.ts')
  const runs = Array.from({ length: 6 }, () => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', `(await import(${JSON.stringify(store)})).openStore(${JSON.stringify(file)})`])
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    return new Promise<string>((r) => p.on('exit', (code) => r(code === 0 ? 'ok' : err.split('\n').find((l) => /Error/.test(l)) ?? `exit ${code}`)))
  })
  assert.deepEqual(await Promise.all(runs), Array(6).fill('ok'))
})

test('remove: a thread takes its replies and screenshot with it; a reply goes alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-'))
  const s = openStore(join(dir, 'comments.db'))
  const t = s.create({ url: '/', author: 'A', body: 'thread', owner: 'h1' })
  const r1 = s.create({ parent_id: t.id, author: 'B', body: 'r1', owner: 'h2' })
  s.create({ parent_id: t.id, author: 'C', body: 'r2' })
  s.saveScreenshot(t.id, JPEG, 'image/jpeg')
  assert.equal(s.owner(t.id), 'h1')
  assert.equal(s.owner(r1.id), 'h2')

  s.remove(r1.id)
  assert.deepEqual(s.get(t.id)!.replies.map((r) => r.body), ['r2'])

  s.remove(t.id)
  assert.equal(s.get(t.id), undefined)
  assert.equal(s.list({}).length, 0)
  assert.equal(existsSync(join(dir, 'shots', `${t.id}.jpg`)), false)
  assert.equal(s.owner('missing'), undefined)
})
