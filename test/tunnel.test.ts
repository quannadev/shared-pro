import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { startTunnel } from '../src/tunnel.ts'

const FIXTURE = join(import.meta.dirname, 'fixtures', 'cloudflared-quick.log')
const URL_IN_FIXTURE = 'https://pushing-snow-hosted-fragrances.trycloudflare.com'
const dir = mkdtempSync(join(tmpdir(), 'sp-tunnel-'))

/** Fake cloudflared: records its args + pid, replays stderr, then runs `tail` (default: stay alive). */
function fakeBin(name: string, tail = 'exec sleep 30', fixture = FIXTURE) {
  const bin = join(dir, name)
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$@" > "${bin}.args"\necho $$ > "${bin}.pid"\ncat "${fixture}" >&2\n${tail}\n`,
  )
  chmodSync(bin, 0o755)
  return bin
}
const alive = (pid: number) => {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

test('resolves with the trycloudflare URL once the connection is registered; stop() kills it', async () => {
  const bin = fakeBin('ok')
  const t = startTunnel({ port: 4321, bin })
  assert.equal(await t.ready, URL_IN_FIXTURE)
  assert.equal(readFileSync(`${bin}.args`, 'utf8').trim(), 'tunnel --url http://localhost:4321')
  t.stop()
  await once(t.child, 'exit')
  assert.equal(alive(Number(readFileSync(`${bin}.pid`, 'utf8'))), false)
})

test('URL without a registered connection is not "ready" (times out)', async () => {
  const partial = join(dir, 'partial.log')
  writeFileSync(partial, readFileSync(FIXTURE, 'utf8').split('\n').slice(0, 6).join('\n'))
  await assert.rejects(startTunnel({ port: 1, bin: fakeBin('partial', 'exec sleep 30', partial), timeoutMs: 300 }).ready, /within/)
})

test('missing binary gives an install hint', async () => {
  await assert.rejects(startTunnel({ port: 1, bin: join(dir, 'does-not-exist') }).ready, /brew install cloudflared/)
})

test('cloudflared exiting early reports its last stderr lines', async () => {
  const bin = fakeBin('dies', 'echo "ERR failed to request quick Tunnel: Post \\"https://api.trycloudflare.com/tunnel\\"" >&2; exit 1', '/dev/null')
  await assert.rejects(startTunnel({ port: 1, bin }).ready, (e: Error) => {
    assert.match(e.message, /exited \(code 1\)/)
    assert.match(e.message, /failed to request quick Tunnel/)
    return true
  })
})

test('CLI killed while cloudflared is still starting does not leave it running', async () => {
  const silent = join(dir, 'silent.log')
  writeFileSync(silent, 'INF Requesting new quick Tunnel on trycloudflare.com...\n')
  const bin = fakeBin('slow', 'exec sleep 30', silent) // never becomes ready, never writes again
  const cli = spawn(process.execPath, [
    join(import.meta.dirname, '..', 'src', 'cli.ts'),
    '--target', '1', '--port', '0', '--dir', mkdtempSync(join(tmpdir(), 'sp-cli-')), '--cloudflared', bin,
  ])
  for (let i = 0; i < 40 && !existsSync(`${bin}.pid`); i++) await new Promise((r) => setTimeout(r, 50))
  const pid = Number(readFileSync(`${bin}.pid`, 'utf8'))
  cli.kill('SIGINT')
  await once(cli, 'exit')
  for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50))
  assert.equal(alive(pid), false, 'cloudflared must not outlive the CLI')
})

test('CLI prints the full share link and kills cloudflared on SIGTERM', async () => {
  const bin = fakeBin('cli')
  const data = mkdtempSync(join(tmpdir(), 'sp-cli-'))
  const cli = spawn(process.execPath, [
    join(import.meta.dirname, '..', 'src', 'cli.ts'),
    '--target', '1', '--port', '0', '--dir', data, '--cloudflared', bin, '--path', '/qtw-project-manager',
  ])
  let shareLine = ''
  for await (const line of createInterface({ input: cli.stdout })) {
    if (line.startsWith('share link:')) {
      shareLine = line
      break
    }
  }
  const token = readFileSync(join(data, '.shared-pro', 'token'), 'utf8').trim()
  assert.equal(shareLine, `share link: ${URL_IN_FIXTURE}/qtw-project-manager?sp=${token}`)

  const pid = Number(readFileSync(`${bin}.pid`, 'utf8'))
  assert.ok(alive(pid))
  cli.kill('SIGTERM')
  await once(cli, 'exit')
  for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50))
  assert.equal(alive(pid), false, 'cloudflared must not outlive the CLI')
  assert.ok(existsSync(join(data, '.shared-pro', 'comments.db')))
})

test('CLI on a busy port exits 1 with a readable message, not a stack trace', async () => {
  const { createServer } = await import('node:net')
  const busy = createServer().listen(0)
  await once(busy, 'listening')
  const port = (busy.address() as { port: number }).port
  const cli = spawn(process.execPath, [
    join(import.meta.dirname, '..', 'src', 'cli.ts'),
    '--target', '1', '--port', String(port), '--no-tunnel', '--dir', mkdtempSync(join(tmpdir(), 'sp-cli-')),
  ])
  let stderr = ''
  cli.stderr.on('data', (d) => (stderr += d))
  const [code] = await once(cli, 'exit')
  busy.close()
  assert.equal(code, 1)
  assert.match(stderr, new RegExp(`port ${port} is already in use`))
  assert.doesNotMatch(stderr, /node:events|Unhandled/)
})
