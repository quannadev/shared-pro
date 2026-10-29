import http from 'node:http'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { handleApi, shareCookie, type Changes } from './api.ts'
import type { Store } from './store.ts'

const SCRIPT = '<script type="module" src="/__sp/widget.js"></script>'
const WIDGET = new URL('../widget/widget.js', import.meta.url)
// Self-contained ESM build (no imports), lazy-loaded by the widget only when someone actually comments.
const SCREENSHOT_LIB = new URL(import.meta.resolve('modern-screenshot'))
const HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer']

export function createProxy({ target, store, token }: { target: string; store: Store; token?: string }) {
  const t = new URL(target)
  const port = Number(t.port) || 80
  // Host → target (Vite allowedHosts). Origin → target only if the browser saw it as same-origin,
  // so Next's dev cross-origin guard passes for the tunnel but still blocks foreign sites.
  const rewrite = (name: string, value: string, host: string | undefined) => {
    const k = name.toLowerCase()
    if (k === 'host') return t.host
    if (k === 'origin' && URL.canParse(value) && new URL(value).host === host) return t.origin
    return value
  }

  // ponytail: every waiting client wakes on every change and refetches its own page; key by url if pages get busy.
  const changes: Changes = { version: 0, waiters: new Set() }
  const unwatch = store.watch(() => (changes.version++, changes.waiters.forEach((wake) => wake())))

  const server = http.createServer((req, res) => {
    const cookie = token && shareCookie(req, token)
    if (req.url?.startsWith('/__sp/')) {
      if (req.url.startsWith('/__sp/api/')) return void handleApi(req, res, store, token, changes)
      if (req.url.startsWith('/__sp/vendor/modern-screenshot.js')) {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' })
        return res.end(readFileSync(SCREENSHOT_LIB))
      }
      if (req.url.startsWith('/__sp/widget.js')) {
        // Read per request: tiny file, and edits show up on reload without restarting the proxy.
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(readFileSync(WIDGET))
      }
      return res.writeHead(404).end()
    }
    const headers: http.OutgoingHttpHeaders = {}
    for (const [k, v] of Object.entries(req.headers)) headers[k] = typeof v === 'string' ? rewrite(k, v, req.headers.host) : v
    delete headers['accept-encoding'] // keep upstream bodies plain so we can append to HTML
    const upReq = http.request({ host: t.hostname, port, method: req.method, path: req.url, headers }, (upRes) => {
      const out = { ...upRes.headers }
      for (const h of HOP) delete out[h]
      const inject =
        /text\/html/.test(out['content-type'] ?? '') && req.method !== 'HEAD' && upRes.statusCode !== 204 && upRes.statusCode !== 304
      if (inject) delete out['content-length']
      if (cookie) out['set-cookie'] = [...(out['set-cookie'] ?? []), cookie] // keep the app's own cookies
      res.writeHead(upRes.statusCode ?? 502, out)
      upRes.pipe(res, { end: !inject })
      if (inject) upRes.on('end', () => res.end(SCRIPT))
    })
    upReq.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`shared-pro: upstream ${target} unreachable (${e.message})`)
    })
    req.pipe(upReq)
  })

  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(port, t.hostname, () => {
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        raw += `${req.rawHeaders[i]}: ${rewrite(req.rawHeaders[i], req.rawHeaders[i + 1], req.headers.host)}\r\n`
      }
      up.write(raw + '\r\n')
      up.write(head)
      socket.pipe(up).pipe(socket)
    })
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
    up.on('close', () => socket.destroy())
    socket.on('close', () => up.destroy())
  })

  server.on('close', unwatch)
  return server
}
