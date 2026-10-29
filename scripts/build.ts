// src/*.ts → dist/*.js with Node's own type stripper (no build dependency). Needed because Node refuses to
// strip types from .ts files inside node_modules, i.e. once the package is installed.
import { stripTypeScriptTypes } from 'node:module'
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

process.removeAllListeners('warning') // stripTypeScriptTypes is "experimental": irrelevant at build time
const root = join(import.meta.dirname, '..')
const src = join(root, 'src')
const dist = join(root, 'dist')

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist)
for (const file of readdirSync(src).filter((f) => f.endsWith('.ts'))) {
  const js = stripTypeScriptTypes(readFileSync(join(src, file), 'utf8'), { mode: 'strip' }).replace(
    /(from\s+'\.\/[\w-]+)\.ts'/g,
    "$1.js'",
  )
  writeFileSync(join(dist, file.replace(/\.ts$/, '.js')), js)
}
chmodSync(join(dist, 'cli.js'), 0o755)
