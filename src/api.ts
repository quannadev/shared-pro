import type http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { NewComment, Status, Store } from './store.ts'

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

/** `?sp=TOKEN` on any page → cookie + redirect to the same URL without it. Returns true if handled. */
export function handleShareLink(req: http.IncomingMessage, res: http.ServerResponse, token: string) {
  const u = new URL(req.url!, 'http://x')
  const given = u.searchParams.get('sp')
  if (given === null) return false
  u.searchParams.delete('sp')
  const headers: http.OutgoingHttpHeaders = { location: u.pathname + u.search, 'cache-control': 'no-store' }
  if (sameSecret(given, token)) headers['set-cookie'] = `sp_token=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
  res.writeHead(302, headers).end()
  return true
}

function hasToken(req: http.IncomingMessage, token: string | undefined) {
  if (!token) return true
  const m = /(?:^|;\s*)sp_token=([^;]+)/.exec(req.headers.cookie ?? '')
  return !!m && sameSecret(m[1], token)
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'content-type must be application/json')
  if (Number(req.headers['content-length']) > MAX_BODY) throw new HttpError(413, 'body too large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req as AsyncIterable<Buffer>) {
    if ((size += c.length) > MAX_BODY) throw new HttpError(413, 'body too large')
    chunks.push(c)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return bad('invalid JSON')
  }
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
  }
}

export async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, store: Store, token?: string) {
  const send = (status: number, data: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(data))
  }
  try {
    if (!hasToken(req, token)) throw new HttpError(401, 'missing or invalid share token, open the shared link (?sp=…) again')
    const u = new URL(req.url!, 'http://x')
    const m = /^\/__sp\/api\/comments(?:\/([^/]+))?$/.exec(u.pathname)
    const id = m?.[1] && decodeURIComponent(m[1])

    if (m && !id && req.method === 'GET') {
      const status = u.searchParams.get('status') ?? undefined
      if (status && !STATUSES.includes(status as Status)) bad('status must be open or resolved')
      return send(200, { threads: store.list({ url: u.searchParams.get('url') ?? undefined, status: status as Status }) })
    }
    if (m && !id && req.method === 'POST') return send(201, store.create(parseNewComment(await readJson(req))))
    if (id && req.method === 'PATCH') {
      const { status } = ((await readJson(req)) ?? {}) as { status?: unknown }
      if (!STATUSES.includes(status as Status)) bad('status must be open or resolved')
      const thread = store.setStatus(id, status as Status)
      return thread ? send(200, thread) : send(404, { error: 'thread not found' })
    }
    throw new HttpError(404, 'not found')
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.message })
    if (e instanceof RangeError) return send(400, { error: e.message })
    console.error('shared-pro api error', e)
    send(500, { error: 'internal error' })
  }
}
