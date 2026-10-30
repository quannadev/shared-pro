#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createProxy } from './server.ts'
import { createMcpServer } from './mcp.ts'
import { openStore } from './store.ts'
import { startTunnel } from './tunnel.ts'

const USAGE = `usage:
  shared-pro [start] --target 3000 [--port 3100] [--path /base] [--dir .] [--public] [--no-tunnel] [--cloudflared bin]
                    [--tunnel-name NAME --hostname review.example.com]   fixed URL via your own named tunnel
  shared-pro mcp [--dir .]      MCP server on stdio for AI agents (reads <dir>/.shared-pro/comments.db)`

const usageError = (msg: string): never => {
  console.error(`shared-pro: ${msg}\n${USAGE}`)
  process.exit(2)
}

function parse() {
  try {
    return parseArgs({
      allowNegative: true,
      allowPositionals: true,
      options: {
        target: { type: 'string', default: '3000' },
        port: { type: 'string', default: '3100' },
        dir: { type: 'string', default: process.cwd() },
        path: { type: 'string', default: '/' }, // page the share link opens, e.g. your Next basePath
        public: { type: 'boolean', default: false },
        tunnel: { type: 'boolean', default: true },
        cloudflared: { type: 'string', default: 'cloudflared' },
        'tunnel-name': { type: 'string' },
        hostname: { type: 'string' },
      },
    })
  } catch (e) {
    return usageError((e as Error).message) // typo'd or value-less flag: short message, not a stack trace
  }
}
const { values, positionals } = parse()
const command = positionals[0] ?? 'start'
if (!['start', 'mcp'].includes(command) || positionals.length > 1) usageError(`unknown command: ${positionals.join(' ')}`)
const tunnelName = values['tunnel-name']
const hostname = values.hostname?.replace(/^https?:\/\//, '').replace(/\/+$/, '')
if (tunnelName && !hostname) usageError('--tunnel-name needs --hostname (the DNS name you routed to that tunnel)')
if (hostname && !tunnelName) usageError('--hostname only applies together with --tunnel-name')
if (tunnelName && !/^[\w.-]+$/.test(tunnelName)) usageError(`invalid --tunnel-name: ${tunnelName}`)
if (hostname && !/^[a-z0-9.-]+$/i.test(hostname)) usageError(`invalid --hostname: ${values.hostname}`)

const dataDir = join(resolve(values.dir!), '.shared-pro')
const store = openStore(join(dataDir, 'comments.db'))
writeFileSync(join(dataDir, '.gitignore'), '*\n')

if (command === 'mcp') {
  // stdout is the protocol channel: nothing else may print to it in this mode.
  await createMcpServer(store).connect(new StdioServerTransport())
} else {
  start()
}

function start() {
  const target = /^\d+$/.test(values.target!) ? `http://localhost:${values.target}` : values.target!

  // Persisted so links already sent to reviewers survive a restart.
  const tokenFile = join(dataDir, 'token')
  const token = values.public
    ? undefined
    : existsSync(tokenFile)
      ? readFileSync(tokenFile, 'utf8').trim()
      : (writeFileSync(tokenFile, randomBytes(18).toString('base64url'), { mode: 0o600 }), readFileSync(tokenFile, 'utf8'))

  const link = (origin: string) => `${origin}${values.path}${token ? `?sp=${token}` : ''}`
  let stopTunnel = () => {}
  const shutdown = () => (stopTunnel(), process.exit(0))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Started from $HOME (or any non-project folder), comments land somewhere the MCP server of the project never looks.
  const projectDir = resolve(values.dir!)
  if (!['package.json', '.git'].some((f) => existsSync(join(projectDir, f)))) {
    console.error(
      `shared-pro: warning: ${projectDir} is not a project folder (no package.json or .git).\n` +
        `  Comments are stored in ${dataDir}. Run shared-pro from your app's folder, or point the AI agent here:\n` +
        `  shared-pro mcp --dir ${projectDir}`,
    )
  }

  const server = createProxy({ target, store, token })
  server.on('error', (e: NodeJS.ErrnoException) => {
    console.error(e.code === 'EADDRINUSE' ? `shared-pro: port ${values.port} is already in use, pick another with --port` : `shared-pro: ${e.message}`)
    process.exit(1)
  })
  server.listen(Number(values.port), async () => {
    const { port } = server.address() as AddressInfo
    console.log(`proxy:      http://localhost:${port} → ${target}`)
    console.log(`comments:   ${join(dataDir, 'comments.db')}`)
    console.log(`local link: ${link(`http://localhost:${port}`)}`)
    if (!values.tunnel) return
    console.log('tunnel:     starting cloudflared…')
    const t = startTunnel({ port, bin: values.cloudflared, name: tunnelName, hostname })
    stopTunnel = t.stop
    try {
      const url = await t.ready
      t.child.on('exit', (code) => {
        console.error(`tunnel:     cloudflared exited (code ${code}), share link is dead. Restart shared-pro.`)
        process.exit(1)
      })
      console.log(`share link: ${link(url)}`)
      if (!token) console.log('            (--public: anyone with this URL can read and write comments)')
    } catch (e) {
      console.error(`tunnel:     ${(e as Error).message}`)
      process.exit(1)
    }
  })
}
