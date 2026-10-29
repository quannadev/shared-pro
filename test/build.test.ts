import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// Node will not strip types from .ts files inside node_modules, so an installed package must ship plain JS.
const root = join(import.meta.dirname, '..')
const cli = join(root, 'dist', 'cli.js')

test('build emits plain JS (no .ts imports, executable bin) that runs as CLI, MCP server and proxy', async () => {
  const build = spawnSync(process.execPath, [join(root, 'scripts', 'build.ts')], { encoding: 'utf8' })
  assert.equal(build.status, 0, build.stderr)

  for (const f of readdirSync(join(root, 'dist'))) {
    assert.doesNotMatch(readFileSync(join(root, 'dist', f), 'utf8'), /from '\.\/[\w-]+\.ts'/, f)
  }
  accessSync(cli, constants.X_OK)

  assert.equal(spawnSync(process.execPath, [cli, 'bogus']).status, 2)

  const mcp = new Client({ name: 'build-test', version: '0' })
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--dir', mkdtempSync(join(tmpdir(), 'sp-'))] }))
  assert.equal((await mcp.listTools()).tools.length, 4)
  await mcp.close()

  const proxy = spawn(process.execPath, [cli, '--target', '1', '--port', '0', '--no-tunnel', '--public', '--dir', mkdtempSync(join(tmpdir(), 'sp-'))])
  let base = ''
  for await (const line of createInterface({ input: proxy.stdout })) {
    base = /proxy:\s+(http:\/\/localhost:\d+)/.exec(line)?.[1] ?? ''
    if (base) break
  }
  try {
    assert.equal((await fetch(`${base}/__sp/widget.js`)).status, 200)
    assert.equal((await fetch(`${base}/__sp/vendor/modern-screenshot.js`)).status, 200)
  } finally {
    proxy.kill()
    await once(proxy, 'exit')
  }
})
