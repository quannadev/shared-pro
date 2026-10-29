import type http from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Comment, NewComment, ShotType, Status, Store, Thread } from './store.ts'

const MAX_BODY = 64 * 1024
const STATUSES: Status[] = ['open', 'resolved']

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
const bad = (msg: string): never => {
  throw new HttpError(400, msg)
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * `?sp=TOKEN` on any page → the cookie to attach to that page's response. No redirect and the param stays in
 * the URL, so a copied URL or "Open in Safari" from an in-app browser still carries the token along.
 */
export function shareCookie(req: http.IncomingMessage, token: string): string | undefined {
  const given = new URL(req.url!, 'http://x').searchParams.get('sp')
  if (given !== null && sameSecret(given, token)) return `sp_token=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
}

function hasToken(req: http.IncomingMessage, token: string | undefined) {
  if (!token) return true
  const m = /(?:^|;\s*)sp_token=([^;]+)/.exec(req.headers.cookie ?? '')
  return !!m && sameSecret(m[1], token)
}

async function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  if (Number(req.headers['content-length']) > max) throw new HttpError(413, 'body too large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req as AsyncIterable<Buffer>) {
    if ((size += c.length) > max) throw new HttpError(413, 'body too large')
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'content-type must be application/json')
  const body = await readBody(req, MAX_BODY)
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return bad('invalid JSON')
  }
}

const MAX_SHOT = 3 * 1024 * 1024
// Only raster formats, recognised by their magic bytes: never trust the declared type (SVG would be script).
const SHOT_MAGIC: [ShotType, number[]][] = [
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
]

async function readScreenshot(req: http.IncomingMessage): Promise<{ data: Buffer; type: ShotType }> {
  const declared = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (!SHOT_MAGIC.some(([t]) => t === declared)) throw new HttpError(415, 'screenshot must be image/jpeg or image/png')
  const data = await readBody(req, MAX_SHOT)
  const type = SHOT_MAGIC.find(([, magic]) => magic.every((b, i) => data[i] === b))?.[0]
  if (type !== declared) bad('body is not a valid ' + declared)
  return { data, type: type! }
}

function text(o: Record<string, unknown>, k: string, max: number, required = false): string | undefined {
  const v = o[k]
  if (v === undefined || v === null) return required ? bad(`${k} is required`) : undefined
  if (typeof v !== 'string') return bad(`${k} must be a string`)
  const s = v.trim()
  if (required && !s) return bad(`${k} is required`)
  if (s.length > max) return bad(`${k} is longer than ${max} characters`)
  return s || undefined
}

function percent(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) return bad(`${k} must be a number 0..100`)
  return v
}

// Trust boundary: everything a reviewer sends is validated here. by_agent is never read from input.
function parseNewComment(input: unknown): NewComment {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('body must be a JSON object')
  const o = input as Record<string, unknown>
  const url = text(o, 'url', 2000)
  if (url !== undefined && (!url.startsWith('/') || url.startsWith('//'))) bad('url must be a path starting with /')
  const parent_id = text(o, 'parent_id', 100)
  if (!parent_id && !url) bad('url is required for a new thread')
  return {
    parent_id,
    url,
    author: text(o, 'author', 100, true)!,
    body: text(o, 'body', 5000, true)!,
    selector: text(o, 'selector', 1000),
    text_snippet: text(o, 'text_snippet', 500),
    html_snippet: text(o, 'html_snippet', 4096),
    source_hint: text(o, 'source_hint', 500),
    viewport: text(o, 'viewport', 20),
    pos_x: percent(o, 'pos_x'),
    pos_y: percent(o, 'pos_y'),
    area_w: percent(o, 'area_w'),
    area_h: percent(o, 'area_h'),
  }
}

/**
 * Who wrote what, without accounts: the widget sends a random per-browser key (x-sp-client). Only its sha256 is
 * stored, and responses carry `mine` instead of the hash, so nobody can read another browser's key.
 */
function clientKey(req: http.IncomingMessage): string | null {
  const key = req.headers['x-sp-client']
  return typeof key === 'string' && /^[a-f0-9]{32}$/.test(key) ? createHash('sha256').update(key).digest('hex') : null
}
const view = (c: Comment, key: string | null) => {
  const { owner, ...rest } = c
  return { ...rest, mine: key !== null && owner === key }
}
const viewThread = (t: Thread, key: string | null) => ({ ...view(t, key), replies: t.replies.map((r) => view(r, key)) })

/**
 * Long-poll hub. `version` bumps on every store write; held /changes requests are answered on the next bump.
 * Not SSE: Cloudflare Quick Tunnels buffer SSE (documented limitation), but short plain responses pass straight through.
 */
export type Changes = { version: number; waiters: Set<() => void> }
const MAX_WAIT_MS = 25_000 // well under Cloudflare's 100s origin timeout

export async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: Store,
  token: string | undefined,
  changes: Changes,
) {
  const send = (status: number, data: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(data))
  }
  try {
    if (!hasToken(req, token)) throw new HttpError(401, 'missing or invalid share token, open the shared link (?sp=…) again')
    const u = new URL(req.url!, 'http://x')
    if (u.pathname === '/__sp/api/changes' && req.method === 'GET') {
      const since = Number(u.searchParams.get('since') ?? NaN)
      if (!Number.isInteger(since)) bad('since must be an integer')
      if (since !== changes.version) return send(200, { version: changes.version })
      const wait = Math.min(Number(u.searchParams.get('wait')) || MAX_WAIT_MS, MAX_WAIT_MS)
      return await new Promise<void>((done) => {
        const finish = () => (clearTimeout(timer), changes.waiters.delete(reply), done())
        const reply = () => (res.writableEnded || send(200, { version: changes.version }), finish())
        const timer = setTimeout(reply, wait)
        changes.waiters.add(reply)
        res.on('close', finish) // client went away (tab closed, navigation): drop the waiter
      })
    }
    const shot = /^\/__sp\/api\/comments\/([^/]+)\/screenshot$/.exec(u.pathname)
    if (shot) {
      const threadId = decodeURIComponent(shot[1])
      if (!store.get(threadId)) throw new HttpError(404, 'thread not found')
      if (req.method === 'GET') {
        const img = store.screenshot(threadId)
        if (!img) throw new HttpError(404, 'no screenshot')
        res.writeHead(200, { 'content-type': img.type, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=3600' })
        return res.end(img.data)
      }
      if (req.method === 'POST') {
        // The thread's author, once (the widget sends it right after creating the thread): nobody can swap it later.
        const owner = store.owner(threadId)
        if (owner && owner !== clientKey(req)) throw new HttpError(403, 'only the author of this thread can attach its screenshot')
        if (store.get(threadId)!.screenshot) throw new HttpError(409, 'thread already has a screenshot')
        const { data, type } = await readScreenshot(req)
        store.saveScreenshot(threadId, data, type)
        return send(201, { ok: true })
      }
    }
    const key = clientKey(req)
    const m = /^\/__sp\/api\/comments(?:\/([^/]+))?$/.exec(u.pathname)
    const id = m?.[1] && decodeURIComponent(m[1])

    if (m && !id && req.method === 'GET') {
      const status = u.searchParams.get('status') ?? undefined
      if (status && !STATUSES.includes(status as Status)) bad('status must be open or resolved')
      const threads = store.list({ url: u.searchParams.get('url') ?? undefined, status: status as Status })
      return send(200, { threads: threads.map((t) => viewThread(t, key)) })
    }
    if (m && !id && req.method === 'POST') return send(201, view(store.create({ ...parseNewComment(await readJson(req)), owner: key }), key))
    if (id && req.method === 'PATCH') {
      const { status } = ((await readJson(req)) ?? {}) as { status?: unknown }
      if (!STATUSES.includes(status as Status)) bad('status must be open or resolved')
      // Resolving means "fixed", and only the AI agent (MCP resolve_comment) says that. People can only reopen.
      if (status === 'resolved') throw new HttpError(403, 'only the AI agent can resolve a thread (via MCP resolve_comment)')
      const thread = store.setStatus(id, status as Status)
      return thread ? send(200, viewThread(thread, key)) : send(404, { error: 'thread not found' })
    }
    if (id && req.method === 'DELETE') {
      const owner = store.owner(id)
      if (owner === undefined) throw new HttpError(404, 'comment not found')
      // Only the browser that wrote it; comments without an owner (older ones, the AI agent's) stay.
      if (!key || owner !== key) throw new HttpError(403, 'you can only delete comments you wrote in this browser')
      store.remove(id)
      res.writeHead(204, { 'cache-control': 'no-store' })
      return res.end()
    }
    throw new HttpError(404, 'not found')
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.message })
    if (e instanceof RangeError) return send(400, { error: e.message })
    console.error('shared-pro api error', e)
    send(500, { error: 'internal error' })
  }
}
