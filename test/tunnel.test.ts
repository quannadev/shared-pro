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

test('CLI warns when --dir is not a project folder (e.g. started from $HOME)', async () => {
  const start = async (dir: string) => {
    const cli = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), '--target', '1', '--port', '0', '--no-tunnel', '--dir', dir])
    let out = ''
    cli.stdout.on('data', (d) => (out += d))
    cli.stderr.on('data', (d) => (out += d))
    for (let i = 0; i < 100 && !/local link:/.test(out); i++) await new Promise((r) => setTimeout(r, 30))
    cli.kill()
    await once(cli, 'exit')
    return out
  }
  const bare = mkdtempSync(join(tmpdir(), 'sp-home-'))
  assert.match(await start(bare), /not a project folder[\s\S]*shared-pro mcp --dir/)
  const project = mkdtempSync(join(tmpdir(), 'sp-proj-'))
  writeFileSync(join(project, 'package.json'), '{}')
  assert.doesNotMatch(await start(project), /not a project folder/)
})

test('--local: no tunnel at all and the proxy only answers on this machine (127.0.0.1)', async () => {
  const { networkInterfaces } = await import('node:os')
  const { connect } = await import('node:net')
  const bin = fakeBin('never-started')
  const cli = spawn(process.execPath, [
    join(import.meta.dirname, '..', 'src', 'cli.ts'),
    '--target', '1', '--port', '0', '--local', '--dir', mkdtempSync(join(tmpdir(), 'sp-local-')), '--cloudflared', bin,
  ])
  let out = ''
  cli.stdout.on('data', (d) => (out += d))
  cli.stderr.on('data', (d) => (out += d))
  for (let i = 0; i < 100 && !/local link:/.test(out); i++) await new Promise((r) => setTimeout(r, 30))
  const port = Number(/proxy:\s+http:\/\/localhost:(\d+)/.exec(out)?.[1])
  const reach = (host: string) =>
    new Promise<boolean>((r) => {
      const s = connect(port, host, () => (s.destroy(), r(true)))
      s.on('error', () => r(false))
    })
  try {
    assert.ok(port > 0, out)
    assert.match(out, /local only/)
    assert.doesNotMatch(out, /tunnel:/)
    assert.equal(existsSync(`${bin}.pid`), false, 'cloudflared never started')
    assert.equal(await reach('127.0.0.1'), true)
    const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address
    if (lan) assert.equal(await reach(lan), false, `not reachable from the LAN (${lan})`)
  } finally {
    cli.kill()
    await once(cli, 'exit')
  }
})

test('--local cannot be combined with a named tunnel', async () => {
  const cli = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), '--local', '--tunnel-name', 'x', '--hostname', 'a.example.com'])
  let err = ''
  cli.stderr.on('data', (d) => (err += d))
  assert.equal((await once(cli, 'exit'))[0], 2)
  assert.match(err, /--local/)
})

// `shared-pro embed`: no proxy, just the widget + API for a site that includes our <script>.
const runCli = (args: string[]) => {
  const cli = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), ...args])
  let out = ''
  cli.stdout.on('data', (d) => (out += d))
  cli.stderr.on('data', (d) => (out += d))
  return { cli, out: () => out }
}

test('embed: argument errors (no --origin, not an origin, --target, --public)', async () => {
  for (const [args, msg] of [
    [['embed'], /--origin/],
    [['embed', '--origin', 'https://staging.example.com/app'], /origin/],
    [['embed', '--origin', 'https://staging.example.com', '--target', '3000'], /--target/],
    [['embed', '--origin', 'https://staging.example.com', '--public'], /--public/],
  ] as const) {
    const r = runCli([...args, '--dir', mkdtempSync(join(tmpdir(), 'sp-embed-'))])
    assert.equal((await once(r.cli, 'exit'))[0], 2, args.join(' '))
    assert.match(r.out(), msg, args.join(' '))
  }
})

test('embed --no-tunnel: prints the snippet and the share link on the site; pages are not proxied', async () => {
  const data = mkdtempSync(join(tmpdir(), 'sp-embed-'))
  const r = runCli(['embed', '--origin', 'https://staging.example.com', '--path', '/dashboard', '--port', '0', '--no-tunnel', '--dir', data])
  for (let i = 0; i < 100 && !/share link:/.test(r.out()); i++) await new Promise((res) => setTimeout(res, 30))
  try {
    const port = /server:\s+http:\/\/localhost:(\d+)/.exec(r.out())?.[1]
    const token = readFileSync(join(data, '.shared-pro', 'token'), 'utf8').trim()
    assert.match(r.out(), new RegExp(`<script type="module" src="http://localhost:${port}/__sp/widget\\.js"></script>`), r.out())
    assert.match(r.out(), new RegExp(`share link: https://staging\\.example\\.com/dashboard\\?sp=${token}`))
    assert.equal((await fetch(`http://localhost:${port}/dashboard`)).status, 404)
  } finally {
    r.cli.kill()
    await once(r.cli, 'exit')
  }
})

test('embed with a quick tunnel: snippet uses the tunnel URL and warns that it changes on restart', async () => {
  const r = runCli(['embed', '--origin', 'https://staging.example.com', '--port', '0', '--dir', mkdtempSync(join(tmpdir(), 'sp-embed-')), '--cloudflared', fakeBin('embed-quick')])
  for (let i = 0; i < 100 && !/share link:/.test(r.out()); i++) await new Promise((res) => setTimeout(res, 30))
  try {
    assert.match(r.out(), new RegExp(`src="${URL_IN_FIXTURE.replace(/\./g, '\\.')}/__sp/widget\\.js"`))
    assert.match(r.out(), /changes every restart[\s\S]*--tunnel-name/)
  } finally {
    r.cli.kill('SIGTERM')
    await once(r.cli, 'exit')
  }
})
