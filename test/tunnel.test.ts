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

test('CLI with an unknown flag or missing value prints a short error + usage and exits 2', async () => {
  for (const args of [['--tagret', '3000'], ['--port']]) {
    const cli = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), ...args])
    let stderr = ''
    cli.stderr.on('data', (d) => (stderr += d))
    const [code] = await once(cli, 'exit')
    assert.equal(code, 2, args.join(' '))
    assert.match(stderr, /^shared-pro: .+\nusage:/, args.join(' '))
    assert.doesNotMatch(stderr, /node:internal|ERR_PARSE_ARGS|\n\s+at \S+ \(/, args.join(' '))
  }
})

// Named tunnel: fixed hostname from the user's Cloudflare zone. cloudflared prints no URL for it,
// so "ready" is just the registered connection and the URL is the configured hostname.
test('named tunnel: `tunnel --url … run <name>`, ready on registered connection, URL = hostname', async () => {
  const named = join(dir, 'named.log')
  writeFileSync(named, readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => !/trycloudflare\.com/.test(l)).join('\n'))
  const bin = fakeBin('named', 'exec sleep 30', named)
  const t = startTunnel({ port: 4321, bin, name: 'qtw-review', hostname: 'review.example.com' })
  assert.equal(await t.ready, 'https://review.example.com')
  assert.equal(readFileSync(`${bin}.args`, 'utf8').trim(), 'tunnel --url http://localhost:4321 run qtw-review')
  t.stop()
  await once(t.child, 'exit')
})

test('CLI: --tunnel-name needs --hostname; with both the share link uses the fixed hostname', async () => {
  const run = (args: string[]) => {
    const cli = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), '--target', '1', '--port', '0', ...args])
    let out = ''
    cli.stdout.on('data', (d) => (out += d))
    cli.stderr.on('data', (d) => (out += d))
    return { cli, out: () => out }
  }
  const missing = run(['--tunnel-name', 'qtw-review', '--dir', mkdtempSync(join(tmpdir(), 'sp-cli-'))])
  assert.equal((await once(missing.cli, 'exit'))[0], 2)
  assert.match(missing.out(), /--tunnel-name needs --hostname/)

  const named = join(dir, 'named-cli.log')
  writeFileSync(named, readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => !/trycloudflare\.com/.test(l)).join('\n'))
  const bin = fakeBin('named-cli', 'exec sleep 30', named)
  const data = mkdtempSync(join(tmpdir(), 'sp-cli-'))
  const ok = run(['--tunnel-name', 'qtw-review', '--hostname', 'https://review.example.com/', '--path', '/qtw-project-manager', '--dir', data, '--cloudflared', bin])
  for (let i = 0; i < 100 && !/share link:/.test(ok.out()); i++) await new Promise((r) => setTimeout(r, 50))
  const token = readFileSync(join(data, '.shared-pro', 'token'), 'utf8').trim()
  assert.match(ok.out(), new RegExp(`share link: https://review\\.example\\.com/qtw-project-manager\\?sp=${token}`))
  ok.cli.kill('SIGTERM')
  await once(ok.cli, 'exit')
})
