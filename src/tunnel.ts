import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

// api.trycloudflare.com shows up in error lines; the tunnel URL never uses that label.
const TUNNEL_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/

/**
 * Starts a Cloudflare tunnel to localhost:port: a quick tunnel (random trycloudflare.com URL) or, with `name` +
 * `hostname`, a named tunnel the user created in their own zone (fixed URL). `stop` is usable immediately (so
 * Ctrl+C during startup can't orphan a public tunnel); `ready` resolves with the public URL once a connection is
 * registered (and, for quick tunnels, the URL was printed).
 */
export function startTunnel({
  port,
  bin = 'cloudflared',
  timeoutMs = 30_000,
  name,
  hostname,
}: { port: number; bin?: string; timeoutMs?: number; name?: string; hostname?: string }) {
  const url = `http://localhost:${port}`
  // --url is an option of `tunnel`, so it goes before `run`: cloudflared tunnel --url <url> run <name>
  const args = name ? ['tunnel', '--url', url, 'run', name] : ['tunnel', '--url', url]
  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  const stop = () => child.kill()

  const ready = new Promise<string>((resolve, reject) => {
    let publicUrl = name ? `https://${hostname}` : undefined // named tunnels print no URL: it is the hostname
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
      publicUrl ??= TUNNEL_URL.exec(line)?.[0]
      registered ||= line.includes('Registered tunnel connection')
      if (publicUrl && registered && !settled) {
        settled = true
        clearTimeout(timer)
        resolve(publicUrl)
      }
    })
    child.on('error', (e: NodeJS.ErrnoException) =>
      fail(e.code === 'ENOENT' ? `cloudflared not found (${bin}). Install it: brew install cloudflared, or run with --no-tunnel` : e.message),
    )
    child.on('exit', (code, signal) => fail(`cloudflared exited (code ${code ?? signal}) before the tunnel was ready`))
  })

  return { child, stop, ready }
}
