import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

// api.trycloudflare.com shows up in error lines; the tunnel URL never uses that label.
const TUNNEL_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/

/**
 * Starts a Cloudflare quick tunnel to localhost:port. `stop` is usable immediately (so Ctrl+C during startup
 * can't orphan a public tunnel); `ready` resolves once the URL is printed AND a connection is registered.
 */
export function startTunnel({ port, bin = 'cloudflared', timeoutMs = 30_000 }: { port: number; bin?: string; timeoutMs?: number }) {
  const child = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'ignore', 'pipe'] })
  const stop = () => child.kill()

  const ready = new Promise<string>((resolve, reject) => {
    let url: string | undefined
    let registered = false
    let settled = false
    const tail: string[] = []
    const fail = (msg: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stop()
      reject(new Error(`${msg}${tail.length ? `\n  ${tail.join('\n  ')}` : ''}`))
    }
    const timer = setTimeout(() => fail(`cloudflared did not open a tunnel within ${timeoutMs / 1000}s`), timeoutMs)

    createInterface({ input: child.stderr }).on('line', (line) => {
      tail.push(line)
      if (tail.length > 8) tail.shift()
      url ??= TUNNEL_URL.exec(line)?.[0]
      registered ||= line.includes('Registered tunnel connection')
      if (url && registered && !settled) {
        settled = true
        clearTimeout(timer)
        resolve(url)
      }
    })
    child.on('error', (e: NodeJS.ErrnoException) =>
      fail(e.code === 'ENOENT' ? `cloudflared not found (${bin}). Install it: brew install cloudflared, or run with --no-tunnel` : e.message),
    )
    child.on('exit', (code, signal) => fail(`cloudflared exited (code ${code ?? signal}) before the tunnel was ready`))
  })

  return { child, stop, ready }
}
