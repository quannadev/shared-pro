import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type Status = 'open' | 'resolved'
export type Comment = {
  id: string
  parent_id: string | null
  url: string
  selector: string | null
  text_snippet: string | null
  html_snippet: string | null
  source_hint: string | null
  pos_x: number | null
  pos_y: number | null
  viewport: string | null
  author: string
  body: string
  by_agent: 0 | 1
  status: Status
  created_at: string
  resolved_at: string | null
  screenshot: ShotType | null // set when the reviewer's browser uploaded a screenshot of what they saw
}
export type ShotType = 'image/jpeg' | 'image/png'
export type Thread = Comment & { replies: Comment[] }
export type NewComment = Partial<
  Pick<Comment, 'parent_id' | 'url' | 'selector' | 'text_snippet' | 'html_snippet' | 'source_hint' | 'pos_x' | 'pos_y' | 'viewport'>
> & { author: string; body: string; by_agent?: boolean }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES comments(id),
  url TEXT NOT NULL,
  selector TEXT, text_snippet TEXT, html_snippet TEXT, source_hint TEXT,
  pos_x REAL, pos_y REAL, viewport TEXT,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  by_agent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  screenshot TEXT
);
CREATE INDEX IF NOT EXISTS comments_url ON comments(url);
CREATE INDEX IF NOT EXISTS comments_parent ON comments(parent_id);`

export function openStore(file: string) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  // WAL + busy_timeout: proxy and MCP server are separate processes writing the same file.
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON; ${SCHEMA}`)
  // Migrate DBs created before screenshots existed.
  const columns = (db.prepare('PRAGMA table_info(comments)').all() as { name: string }[]).map((c) => c.name)
  if (!columns.includes('screenshot')) db.exec('ALTER TABLE comments ADD COLUMN screenshot TEXT')
  const shotsDir = file === ':memory:' ? mkdtempSync(join(tmpdir(), 'sp-shots-')) : join(dirname(file), 'shots')
  const shotFile = (id: string, type: ShotType) => join(shotsDir, `${id}.${type === 'image/png' ? 'png' : 'jpg'}`)

  const row = (id: string) => db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as Comment | undefined
  const withReplies = (t: Comment): Thread => ({
    ...t,
    replies: db.prepare('SELECT * FROM comments WHERE parent_id = ? ORDER BY created_at, rowid').all(t.id) as Comment[],
  })
  const listeners = new Set<() => void>()
  const changed = () => listeners.forEach((l) => l())
  // Bumps only for commits by *other* connections (e.g. the MCP process); our own writes call changed() directly.
  const dataVersion = () => (db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version

  return {
    create(c: NewComment): Comment {
      let url = c.url
      if (c.parent_id) {
        const parent = row(c.parent_id)
        if (!parent || parent.parent_id) throw new RangeError('parent thread not found')
        url = parent.url
      }
      if (!url) throw new RangeError('url is required for a new thread')
      const id = randomUUID()
      db.prepare(
        `INSERT INTO comments (id, parent_id, url, selector, text_snippet, html_snippet, source_hint, pos_x, pos_y, viewport, author, body, by_agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ...([
          id, c.parent_id ?? null, url, c.selector ?? null, c.text_snippet ?? null, c.html_snippet ?? null, c.source_hint ?? null,
          c.pos_x ?? null, c.pos_y ?? null, c.viewport ?? null, c.author, c.body, c.by_agent ? 1 : 0, new Date().toISOString(),
        ] satisfies SQLInputValue[]),
      )
      changed()
      return row(id)!
    },

    // ponytail: one query per thread for replies (N+1); fine for a dev review session, batch with IN (...) if lists get big.
    list({ url, status }: { url?: string; status?: Status }): Thread[] {
      const where = ['parent_id IS NULL']
      const args: string[] = []
      if (url) where.push('url = ?'), args.push(url)
      if (status) where.push('status = ?'), args.push(status)
      const roots = db.prepare(`SELECT * FROM comments WHERE ${where.join(' AND ')} ORDER BY created_at, rowid`).all(...args) as Comment[]
      return roots.map(withReplies)
    },

    get(id: string): Thread | undefined {
      const t = row(id)
      return t && !t.parent_id ? withReplies(t) : undefined
    },

    setStatus(id: string, status: Status): Thread | undefined {
      const resolvedAt = status === 'resolved' ? new Date().toISOString() : null
      const { changes } = db
        .prepare('UPDATE comments SET status = ?, resolved_at = ? WHERE id = ? AND parent_id IS NULL')
        .run(status, resolvedAt, id)
      if (!changes) return undefined
      changed()
      return this.get(id)
    },

    /** Stores the image file next to the DB (`shots/<id>.jpg|png`) and flags the comment. */
    saveScreenshot(id: string, data: Buffer, type: ShotType) {
      mkdirSync(shotsDir, { recursive: true })
      writeFileSync(shotFile(id, type), data)
      db.prepare('UPDATE comments SET screenshot = ? WHERE id = ?').run(type, id)
      changed()
    },

    screenshot(id: string): { data: Buffer; type: ShotType } | undefined {
      const type = row(id)?.screenshot
      if (!type) return undefined
      try {
        return { data: readFileSync(shotFile(id, type)), type }
      } catch {
        return undefined // file deleted by hand: treat as no screenshot
      }
    },

    /** Calls `cb` after any write, ours or another process's. Returns an unsubscribe function. */
    watch(cb: () => void, everyMs = 300): () => void {
      listeners.add(cb)
      let last = dataVersion()
      const timer = setInterval(() => {
        const v = dataVersion()
        if (v !== last) (last = v), cb()
      }, everyMs)
      timer.unref() // never keeps the process alive on its own
      return () => (clearInterval(timer), listeners.delete(cb))
    },
  }
}

export type Store = ReturnType<typeof openStore>
