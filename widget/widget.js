// shared-pro review widget. Plain ES module served as-is from /__sp/widget.js (no build step).
// Everything visible lives in a shadow root so the app's CSS and ours never touch.

const API = '/__sp/api/comments'
const MAX_SHOT_NODES = 1500 // ≈ 2s of main thread at the measured ~1.35ms/node: under Chrome's "Page Unresponsive"
const POLL_MS = 5000 // when the long-poll is down
const SAFETY_POLL_MS = 30000 // while it is up, in case a change is ever missed
const T = {
  title: 'Góp ý',
  add: '+ Thêm góp ý (C)',
  cancelPick: 'Hủy chọn (Esc)',
  hint: 'Click vào phần tử, hoặc kéo chuột để khoanh vùng · Esc để thoát',
  open: 'Đang mở',
  resolved: 'Đã xong',
  emptyOpen: 'Chưa có góp ý nào trên trang này.',
  emptyOpenAll: 'Chưa có góp ý nào đang mở.',
  thisPage: 'Trang này',
  allPages: 'Tất cả trang',
  here: 'trang hiện tại',
  emptyResolved: 'Chưa có góp ý nào được xử lý.',
  missing: '⚠ Không còn thấy phần tử này trên trang',
  name: 'Tên của bạn',
  needName: 'Nhập tên trước khi gửi.',
  placeholder: 'Góp ý cho phần tử này… (⌘/Ctrl+Enter để gửi)',
  replyPh: 'Trả lời…',
  send: 'Gửi',
  cancel: 'Hủy',
  reply: 'Trả lời',
  reopen: 'Mở lại',
  delete: 'Xóa',
  confirmDelete: 'Xóa góp ý này? Các trả lời và ảnh chụp đi kèm cũng bị xóa.',
  confirmDeleteReply: 'Xóa trả lời này?',
  screenshot: 'Ảnh chụp màn hình lúc góp ý',
  close: 'Đóng',
  noToken: 'Link thiếu mã chia sẻ. Hãy mở lại đúng link được gửi cho bạn (có ?sp=…).',
}

// ---------- pure helpers (unit-tested with happy-dom) ----------

const isGeneratedId = (id) => /[:«»]/.test(id) || /^\d/.test(id) // React useId, numeric ids
const cssEscape = (el, s) => el.ownerDocument.defaultView?.CSS?.escape?.(s) ?? s.replace(/[^\w-]/g, (c) => `\\${c}`)

/** Shortest-ish selector that uniquely finds `el`: nearest unique #id / data-testid, then tag:nth-of-type steps. */
export function cssPath(el) {
  const doc = el.ownerDocument
  const unique = (sel) => {
    try {
      return doc.querySelectorAll(sel).length === 1
    } catch {
      return false
    }
  }
  const parts = []
  for (let node = el; node && node !== doc.body && node !== doc.documentElement; node = node.parentElement) {
    if (node.id && !isGeneratedId(node.id) && unique(`#${cssEscape(node, node.id)}`)) {
      return [`#${cssEscape(node, node.id)}`, ...parts].join(' > ')
    }
    for (const attr of ['data-testid', 'data-test', 'data-cy']) {
      const v = node.getAttribute(attr)
      const sel = v && `[${attr}="${v.replace(/["\\]/g, '\\$&')}"]`
      if (sel && unique(sel)) return [sel, ...parts].join(' > ')
    }
    const same = [...(node.parentElement?.children ?? [])].filter((c) => c.localName === node.localName)
    parts.unshift(same.length > 1 ? `${node.localName}:nth-of-type(${same.indexOf(node) + 1})` : node.localName)
  }
  return ['body', ...parts].join(' > ')
}

/** What we store about the clicked element so a human and an AI agent can find it again. */
export function describe(el, x, y) {
  const r = el.getBoundingClientRect()
  const pct = (v, start, size) => (size > 0 ? Math.round(Math.min(100, Math.max(0, ((v - start) / size) * 100)) * 10) / 10 : 0)
  const selector = cssPath(el)
  return {
    selector: selector.length <= 1000 ? selector : undefined,
    text_snippet: (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || undefined,
    html_snippet: el.outerHTML.slice(0, 2000),
    pos_x: pct(x, r.left, r.width),
    pos_y: pct(y, r.top, r.height),
  }
}

const contains = (r, box) => r.left <= box.left && r.top <= box.top && r.right >= box.right && r.bottom >= box.bottom

/** Area comments hang off the smallest element that contains the whole dragged box, so they move with the layout. */
export function enclosing(start, box) {
  const doc = start.ownerDocument
  for (let el = start; el && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
    if (contains(el.getBoundingClientRect(), box)) return el
  }
  return doc.body
}

/** Like describe(), plus the box size: top-left in pos_x/pos_y and size in area_w/area_h, all % of `el`. */
export function describeArea(el, box) {
  const r = el.getBoundingClientRect()
  const pct = (v, size) => (size > 0 ? Math.round(Math.min(100, Math.max(0, (v / size) * 100)) * 10) / 10 : 0)
  return { ...describe(el, box.left, box.top), area_w: pct(box.width, r.width), area_h: pct(box.height, r.height) }
}

/** Viewport rect of a stored area, from its anchor's current rect. */
export function areaRect(r, t) {
  const left = r.left + (r.width * t.pos_x) / 100
  const top = r.top + (r.height * t.pos_y) / 100
  const width = (r.width * t.area_w) / 100
  const height = (r.height * t.area_h) / 100
  return { left, top, width, height, right: left + width, bottom: top + height }
}

/**
 * Screenshots cost ~1ms of main-thread time per cloned node (a 9.7k-element page froze the tab for 13s), so an
 * element entirely below the viewport is cloned as an empty shell: its contents cannot be in the picture. The shell
 * itself is kept because removing whole elements (e.g. trailing table rows) blanked a real table's visible rows.
 * Content above the viewport still has to be cloned (removing it would shift the layout).
 */
export function belowViewport(node, viewportHeight) {
  const doc = node.ownerDocument
  return node.nodeType === 1 && node !== doc.body && node !== doc.documentElement && node.getBoundingClientRect().top > viewportHeight + 100
}

/** Capture filter: keep a node unless its parent is an element entirely below the viewport (a shell). */
export function keepInCapture(node, viewportHeight) {
  const parent = node.parentElement
  return !parent || !belowViewport(parent, viewportHeight)
}

/** How many elements a capture would clone under the same rule: shells count, their contents do not. */
export function countCloned(root, isShell) {
  let n = 0
  for (const child of root.children) n += 1 + (isShell(child) ? 0 : countCloned(child, isShell))
  return n
}

/** The page colour usually lives on <html> or <body>, which a DOM capture does not paint by itself (dark themes!). */
export function pageBackground(doc) {
  const view = doc.defaultView
  const isClear = (c) => !c || c === 'transparent' || /^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(c)
  return [doc.documentElement, doc.body].map((el) => view.getComputedStyle(el).backgroundColor).find((c) => !isClear(c)) ?? '#ffffff'
}

const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * The element a thread is about. In order: the selector's element if its text still matches; else the one
 * element whose text is exactly the stored snippet (the DOM shifted, so an nth-of-type selector now silently
 * points at a neighbour); else the selector's element anyway (the fix itself changed the wording); else null.
 * Text is compared case-insensitively: the snippet came from innerText, which applies text-transform.
 */
export function findAnchor(doc, thread) {
  let bySelector = null
  try {
    bySelector = thread.selector ? doc.querySelector(thread.selector) : null
  } catch {}
  const want = norm(thread.text_snippet)
  if (!want) return bySelector
  const textOf = (el) => norm(el.textContent).slice(0, 200)
  if (bySelector && textOf(bySelector) === want) return bySelector
  // Innermost matches only: a wrapper whose sole content is the button has the same text as the button.
  const matches = [...doc.body.querySelectorAll('*')].filter(
    (el) => textOf(el) === want && ![...el.children].some((c) => textOf(c) === want),
  )
  return matches.length === 1 ? matches[0] : bySelector
}

/** Comments are keyed by path + query (basePath kept, hash and share token dropped). */
export function pageKey(loc) {
  const u = new URL(loc.href)
  if (u.searchParams.has('sp')) u.searchParams.delete('sp')
  return u.pathname + u.search
}

/** Flattens and drops null/false/undefined: append()/replaceChildren() would print them as text. */
export const nodes = (...children) => children.flat().filter((c) => c != null && c !== false)

/** Tiny element builder. Strings become text nodes, so untrusted comment text can never become HTML. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else if (k === 'value') el.value = v
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  el.append(...nodes(...children))
  return el
}

const rtf = new Intl.RelativeTimeFormat('vi', { numeric: 'auto' })
function ago(iso) {
  const s = (Date.parse(iso) - Date.now()) / 1000
  for (const [unit, n] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), unit)
  }
  return rtf.format(0, 'second')
}

// ---------- UI ----------

const STYLES = `
* { box-sizing: border-box; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2328; }
[hidden] { display: none !important; }
button { cursor: pointer; border: 1px solid #d0d7de; background: #fff; border-radius: 6px; padding: 4px 10px; }
button:hover { background: #f6f8fa; }
button.primary, button.primary * { background: #2563eb; border-color: #2563eb; color: #fff; }
button.primary:hover { background: #1d4ed8; }
textarea, input { width: 100%; border: 1px solid #d0d7de; border-radius: 6px; padding: 6px 8px; resize: vertical; background: #fff; }
textarea:focus, input:focus { outline: 2px solid #2563eb; outline-offset: -1px; }
.fab { position: fixed; right: 16px; bottom: 16px; height: 40px; min-width: 40px; border-radius: 20px; border: none;
  background: #111827; box-shadow: 0 4px 14px rgba(0,0,0,.25); display: flex; align-items: center; gap: 6px; padding: 0 14px; font-size: 16px; pointer-events: auto; }
.fab, .fab * { color: #fff; } .fab:hover { background: #1f2937; } .fab.picking { background: #2563eb; }
.fab .count { background: #ef4444; border-radius: 10px; padding: 0 6px; font-size: 12px; font-weight: 600; }
.panel { position: fixed; top: 0; right: 0; bottom: 0; width: 360px; max-width: 100vw; background: #fff; border-left: 1px solid #d0d7de;
  box-shadow: -8px 0 24px rgba(0,0,0,.12); display: flex; flex-direction: column; pointer-events: auto; }
header { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid #eaeef2; }
header strong { font-size: 15px; font-weight: 600; }
.icon { border: none; font-size: 20px; line-height: 1; padding: 0 4px; background: none; }
.toolbar { display: flex; flex-direction: column; gap: 8px; padding: 10px 14px; border-bottom: 1px solid #eaeef2; }
.tabs { display: flex; gap: 4px; } .tabs button { flex: 1; }
.page { color: #0969da; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tabs.scope button { padding: 2px 8px; font-size: 12px; }
.tabs button.on { background: #eef2ff; border-color: #2563eb; color: #1d4ed8; }
.list { flex: 1; overflow: auto; padding: 10px 14px; display: flex; flex-direction: column; gap: 10px; }
.card { border: 1px solid #d0d7de; border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 6px; cursor: pointer; }
.card.active { border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,.2); }
.meta { display: flex; align-items: center; gap: 6px; } .meta b { font-weight: 600; }
time { color: #6e7781; font-size: 12px; margin-left: auto; }
.num { min-width: 20px; height: 20px; border-radius: 10px; background: #2563eb; color: #fff; display: inline-flex; align-items: center;
  justify-content: center; font-size: 11px; font-weight: 600; padding: 0 5px; }
.num.done { background: #1a7f37; }
p { margin: 0; } .body { white-space: pre-wrap; word-break: break-word; }
.snippet { color: #6e7781; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.warn { color: #9a6700; font-size: 12px; }
.shot img { display: block; width: 100%; max-height: 160px; object-fit: cover; object-position: top; border: 1px solid #d0d7de; border-radius: 6px; }
.reply { border-left: 3px solid #eaeef2; padding-left: 8px; display: flex; flex-direction: column; gap: 2px; }
.reply.agent { border-left-color: #8250df; }
.replybox { display: flex; flex-direction: column; gap: 6px; cursor: default; }
.danger { color: #cf222e; } .danger:hover { background: #fff1f0; }
.link { border: none; background: none; padding: 0 2px; font-size: 12px; }
.row { display: flex; justify-content: flex-end; gap: 6px; }
.error { margin: 10px 14px 0; padding: 8px; background: #fff1f0; color: #cf222e; border-radius: 6px; }
.empty { color: #6e7781; text-align: center; margin-top: 40px; }
.pin { position: fixed; left: 0; top: 0; margin-top: -28px; width: 28px; height: 28px; padding: 0; border-radius: 14px 14px 14px 2px;
  background: #2563eb; border: 2px solid #fff; box-shadow: 0 2px 6px rgba(0,0,0,.3); font-size: 12px; font-weight: 600; pointer-events: auto; }
.pin, .pin * { color: #fff; } .pin:hover { background: #1d4ed8; } .pin.active { background: #f59e0b; }
.hl { position: fixed; left: 0; top: 0; border: 2px solid #2563eb; background: rgba(37,99,235,.08); border-radius: 3px; pointer-events: none; }
.hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); background: #111827; padding: 6px 12px; border-radius: 6px; pointer-events: none; }
.hint, .hint * { color: #fff; }
.composer { position: fixed; width: 320px; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.18);
  padding: 10px; display: flex; flex-direction: column; gap: 8px; pointer-events: auto; }
`

// Storage can throw (privacy modes, sandboxed frames): treat failures as "nothing stored".
const kv = (storage) => ({
  get: (k) => {
    try {
      return storage().getItem(k) ?? ''
    } catch {
      return ''
    }
  },
  set: (k, v) => {
    try {
      v ? storage().setItem(k, v) : storage().removeItem(k)
    } catch {}
  },
})
const store = kv(() => localStorage)
const session = kv(() => sessionStorage) // survives the navigation to another page of the app

function mount() {
  if (window.__SP_MOUNTED) return
  window.__SP_MOUNTED = true

  const state = {
    url: pageKey(location),
    threads: [],
    filter: 'open',
    scope: session.get('sp_scope') || 'page', // 'page' | 'all'
    open: false,
    picking: false,
    active: null,
    error: null,
    name: store.get('sp_author'),
    nameDraft: '',
  }
  const drafts = new Map() // thread id → unsent reply text, survives re-renders
  let lastJson = ''
  let hoverEl = null
  let drag = null // { x0, y0, x, y, moved } while the mouse is held down in comment mode
  let swallowClick = false // a drag ends with a click on some ancestor: that click must not open a 2nd composer
  let composer = null // { form, target }
  let flashEl = null
  let flashThread = null
  let flashUntil = 0
  let pins = []

  const host = document.createElement('shared-pro-root')
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;'
  const root = host.attachShadow({ mode: 'open' })
  const pinLayer = h('div')
  const hl = h('div', { class: 'hl', hidden: true })
  const hint = h('div', { class: 'hint', hidden: true }, T.hint)
  const panel = h('aside', { class: 'panel', hidden: true })
  const fab = h('button', {
    class: 'fab',
    title: T.title,
    onclick: () => (state.picking ? setPicking(false) : ((state.open = true), render())),
  })
  root.append(h('style', {}, STYLES), pinLayer, hl, hint, panel, fab)
  const attach = () => host.isConnected || document.body.append(host) // React error recovery can replace <body>
  attach()

  const pickStyle = document.createElement('style')
  pickStyle.textContent = '* { cursor: crosshair !important; }'

  // ---- data ----
  // Random per-browser key: the server keeps only its hash and lets this browser delete what it wrote.
  if (!/^[a-f0-9]{32}$/.test(store.get('sp_client'))) {
    store.set('sp_client', [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''))
  }
  const client = { 'x-sp-client': store.get('sp_client') }

  async function api(path, init) {
    const res = await fetch(
      API + path,
      init
        ? { method: init.method, headers: { ...client, 'content-type': 'application/json' }, body: JSON.stringify(init.body) }
        : { headers: client },
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(res.status === 401 ? T.noToken : data.error || `HTTP ${res.status}`)
    return data
  }

  let seq = 0
  let lastLoad = 0
  async function load() {
    const url = state.url
    const mine = ++seq
    lastLoad = Date.now()
    let threads
    try {
      ;({ threads } = await api(state.scope === 'page' ? `?url=${encodeURIComponent(url)}` : ''))
    } catch (e) {
      // Only network/API errors land here; a render bug must stay a loud uncaught error, not a banner.
      if (mine === seq && state.error !== e.message) ((state.error = e.message), render())
      return
    }
    if (mine !== seq || url !== state.url) return // a newer load or a navigation superseded this one
    const json = JSON.stringify(threads)
    if (json === lastJson && !state.error) return
    lastJson = json
    state.threads = threads
    state.error = null
    render()
  }

  const act = (fn) => async () => {
    try {
      await fn()
      await load()
    } catch (e) {
      state.error = e.message
      render()
    }
  }

  const author = (input) => {
    const name = (state.name || input?.value || state.nameDraft || '').trim()
    if (!name) throw new Error(T.needName)
    if (!state.name) store.set('sp_author', (state.name = name))
    return name
  }

  const nameField = (key) =>
    state.name
      ? null
      : h('input', {
          placeholder: T.name,
          maxlength: 100,
          'data-key': key,
          value: state.nameDraft,
          oninput: (e) => (state.nameDraft = e.target.value),
        })

  const submitOnCmdEnter = (send) => (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.preventDefault(), send())
  }

  // ---- screenshot ----
  /** JPEG of the reviewer's viewport with a red box on the clicked element, or null if capture fails. */
  async function captureView(target, area) {
    try {
      const box = rectFor(target, area)
      const isShell = (el) => el === host || belowViewport(el, innerHeight)
      // ponytail: still too big to clone without freezing (deep in a long page)? No picture beats a frozen tab.
      if (countCloned(document.body, isShell) > MAX_SHOT_NODES) return null
      const { domToCanvas } = await import('/__sp/vendor/modern-screenshot.js')
      // ponytail: renders the DOM, not pixels: cross-origin images without CORS come out blank, and fixed
      // headers can be offset when the page is scrolled. Good enough to show the agent what was meant.
      const canvas = await domToCanvas(document.documentElement, {
        width: innerWidth,
        height: innerHeight,
        scale: 1,
        backgroundColor: pageBackground(document),
        timeout: 3000, // per image: default 30s; a stuck decode (seen in background tabs) must not hold the upload
        filter: (node) => node !== host && keepInCapture(node, innerHeight),
        style: { transform: `translate(${-scrollX}px, ${-scrollY}px)` },
      })
      const ctx = canvas.getContext('2d')
      ctx.strokeStyle = '#ef4444'
      ctx.lineWidth = 3
      ctx.strokeRect(box.left - 2, box.top - 2, box.width + 4, box.height + 4)
      return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8))
    } catch (e) {
      console.warn('[shared-pro] screenshot failed', e)
      return null
    }
  }

  // ---- comment mode ----
  function setPicking(on) {
    state.picking = on
    hint.hidden = !on
    if (on) document.head.append(pickStyle)
    else (pickStyle.remove(), (hoverEl = null), (drag = null))
    if (on) closeComposer()
    position()
    render()
  }

  const isOurs = (e) => e.composedPath().includes(host)

  addEventListener(
    'mousemove',
    (e) => {
      if (!state.picking || isOurs(e)) return
      hoverEl = e.target instanceof Element ? e.target : null
      if (drag) Object.assign(drag, { x: e.clientX, y: e.clientY, moved: drag.moved || Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 6 })
      position()
    },
    true,
  )
  // Swallow the whole click sequence so the app doesn't navigate/act while the reviewer is pointing at something.
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']) {
    addEventListener(
      type,
      (e) => {
        if (!state.picking || isOurs(e)) return
        e.preventDefault()
        e.stopImmediatePropagation()
        if (type === 'pointerdown' && e.button === 0) {
          drag = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false }
          swallowClick = false
        }
        if (type === 'pointerup' && drag?.moved) {
          // Dragged a box: comment on that area, anchored to the smallest element containing it.
          const box = dragBox()
          const start = document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2).find((el) => el !== host)
          const anchor = enclosing(start ?? document.body, box)
          swallowClick = true
          setPicking(false)
          return openComposer(anchor, box.right, box.bottom, describeArea(anchor, box))
        }
        if (type === 'pointerup') drag = null
        if (type === 'click' && swallowClick) return void (swallowClick = false)
        if (type === 'click' && e.target instanceof Element) {
          const target = e.target
          setPicking(false)
          openComposer(target, e.clientX, e.clientY)
        }
      },
      true,
    )
  }
  addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && (composer || state.picking)) return composer ? closeComposer() : setPicking(false)
      const t = e.composedPath()[0]
      const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      // Only while the panel is open, so we never steal the app's own "c" shortcut.
      if (state.open && (e.key === 'c' || e.key === 'C') && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) setPicking(!state.picking)
    },
    true,
  )

  function openComposer(target, x, y, areaInfo) {
    closeComposer()
    const info = areaInfo ?? describe(target, x, y)
    const area = areaInfo ?? null
    const shot = captureView(target, area) // starts now, so it shows exactly what was picked; runs while they type
    const name = nameField('name:new')
    const ta = h('textarea', { rows: 3, maxlength: 5000, placeholder: T.placeholder })
    const send = act(async () => {
      if (!ta.value.trim()) return ta.focus()
      const viewport = `${innerWidth}x${innerHeight}`
      const t = await api('', { method: 'POST', body: { url: state.url, ...info, viewport, author: author(name), body: ta.value } })
      closeComposer()
      Object.assign(state, { open: true, filter: 'open', active: t.id })
      // Best effort: the comment is already saved; a failed capture/upload only means no picture.
      shot.then((blob) => blob && fetch(`${API}/${t.id}/screenshot`, { method: 'POST', headers: { ...client, 'content-type': blob.type }, body: blob }))
    })
    ta.addEventListener('keydown', submitOnCmdEnter(send))
    const form = h(
      'form',
      { class: 'composer', onsubmit: (e) => (e.preventDefault(), send()) },
      name,
      ta,
      h('div', { class: 'row' }, h('button', { type: 'button', onclick: closeComposer }, T.cancel), h('button', { type: 'submit', class: 'primary' }, T.send)),
    )
    form.style.left = `${Math.max(8, Math.min(x + 12, innerWidth - 328))}px`
    form.style.top = `${Math.max(8, Math.min(y + 12, innerHeight - 200))}px`
    root.append(form)
    composer = { form, target, area }
    ;(name ?? ta).focus()
    position()
  }

  function closeComposer() {
    composer?.form.remove()
    composer = null
    position()
  }

  // findAnchor may scan the page (text fallback) and position() runs every frame while scrolling: cache per
  // thread, dropped whenever the app's DOM changes. Our own UI lives in the shadow root, so it never triggers this.
  const anchors = new Map()
  new MutationObserver(() => anchors.clear()).observe(document.body, { subtree: true, childList: true, characterData: true })
  const anchorOf = (t) => {
    if (!anchors.has(t.id)) anchors.set(t.id, findAnchor(document, t))
    return anchors.get(t.id)
  }

  // ---- layout (cheap, runs on scroll/resize/tick) ----
  let raf = 0
  const schedule = () => raf || (raf = requestAnimationFrame(() => ((raf = 0), position())))
  addEventListener('scroll', schedule, { capture: true, passive: true })
  addEventListener('resize', schedule)

  function position() {
    for (const { pin, t } of pins) {
      const r = anchorOf(t)?.getBoundingClientRect()
      pin.hidden = !r || r.width + r.height === 0
      if (!pin.hidden) {
        pin.style.transform = `translate(${r.left + (r.width * (t.pos_x ?? 0)) / 100}px, ${r.top + (r.height * (t.pos_y ?? 0)) / 100}px)`
      }
    }
    const live = (el) => el?.isConnected && el
    const activeArea = state.open && state.threads.find((t) => t.id === state.active && t.area_w != null && t.url === state.url)
    const r = state.picking
      ? drag?.moved
        ? dragBox()
        : live(hoverEl)?.getBoundingClientRect()
      : composer
        ? live(composer.target) && rectFor(composer.target, composer.area)
        : Date.now() < flashUntil && live(flashEl)
          ? rectFor(flashEl, flashThread)
          : activeArea && live(anchorOf(activeArea)) && rectFor(anchorOf(activeArea), activeArea) // area stays outlined while selected
    hl.hidden = !r
    if (r) Object.assign(hl.style, { transform: `translate(${r.left}px, ${r.top}px)`, width: `${r.width}px`, height: `${r.height}px` })
  }

  // Element rect, or the stored area inside it for area comments.
  const rectFor = (el, t) => (t?.area_w != null ? areaRect(el.getBoundingClientRect(), t) : el.getBoundingClientRect())
  const dragBox = () => {
    const left = Math.min(drag.x0, drag.x)
    const top = Math.min(drag.y0, drag.y)
    const width = Math.abs(drag.x - drag.x0)
    const height = Math.abs(drag.y - drag.y0)
    return { left, top, width, height, right: left + width, bottom: top + height }
  }

  function flash(el, t = null) {
    flashEl = el
    flashThread = t
    flashUntil = Date.now() + 1600
    position()
    setTimeout(position, 1650)
  }

  function focusThread(id) {
    const t = state.threads.find((x) => x.id === id)
    if (!t) return
    if (t.url !== state.url) {
      // Another page of the app: go there, then reopen the panel on this thread (see the end of mount()).
      session.set('sp_focus', id)
      return location.assign(t.url)
    }
    Object.assign(state, { open: true, active: id, filter: t.status })
    render()
    root.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' })
    const el = anchorOf(t)
    if (el) (el.scrollIntoView({ block: 'center', behavior: 'smooth' }), flash(el, t))
  }

  function setScope(scope) {
    state.scope = scope
    session.set('sp_scope', scope)
    lastJson = ''
    state.threads = []
    render()
    load()
  }

  // ---- render ----
  function render() {
    const open = state.threads.filter((t) => t.status === 'open')
    const resolved = state.threads.filter((t) => t.status === 'resolved')
    const openHere = open.filter((t) => t.url === state.url) // pins and the fab count are about this page only

    // While picking, the panel steps aside so every element is clickable; the fab becomes "cancel".
    fab.hidden = state.open && !state.picking
    fab.title = state.picking ? T.cancelPick : T.title
    fab.classList.toggle('picking', state.picking)
    fab.replaceChildren(...(state.picking ? ['✕'] : nodes('💬', openHere.length > 0 && h('span', { class: 'count' }, openHere.length))))

    pins = openHere.map((t, i) => ({
      t,
      pin: h(
        'button',
        { class: `pin${t.id === state.active ? ' active' : ''}`, title: `${t.author}: ${t.body}`.slice(0, 140), onclick: () => focusThread(t.id) },
        i + 1,
      ),
    }))
    pinLayer.replaceChildren(...pins.map((p) => p.pin))
    position()

    panel.hidden = !state.open || state.picking
    if (panel.hidden) return

    // Keep what the user is typing: focus, caret and list scroll survive the rebuild.
    const focused = root.activeElement
    const key = focused?.dataset?.key
    const caret = [focused?.selectionStart, focused?.selectionEnd]
    const scroll = panel.querySelector('.list')?.scrollTop ?? 0

    const tab = (f, label) =>
      h('button', { class: state.filter === f ? 'on' : '', onclick: () => ((state.filter = f), render()) }, label)
    const scopeTab = (scope, label) =>
      h('button', { class: state.scope === scope ? 'on' : '', onclick: () => setScope(scope) }, label)
    const shown = state.filter === 'open' ? open : resolved
    const list = h(
      'div',
      { class: 'list' },
      shown.length
        ? shown.map((t) => card(t, open.filter((x) => x.url === t.url).indexOf(t))) // numbers match the pins of t's page
        : h('p', { class: 'empty' }, state.filter === 'open' ? (state.scope === 'page' ? T.emptyOpen : T.emptyOpenAll) : T.emptyResolved),
    )
    panel.replaceChildren(
      ...nodes(
      h(
        'header',
        {},
        h('strong', {}, T.title),
        h('button', { class: 'icon', title: T.close, onclick: () => ((state.open = false), setPicking(false)) }, '×'),
      ),
      h(
        'div',
        { class: 'toolbar' },
        h('button', { class: 'primary', onclick: () => setPicking(!state.picking) }, state.picking ? T.cancelPick : T.add),
        h('div', { class: 'tabs scope' }, scopeTab('page', T.thisPage), scopeTab('all', T.allPages)),
        h('div', { class: 'tabs' }, tab('open', `${T.open} (${open.length})`), tab('resolved', `${T.resolved} (${resolved.length})`)),
      ),
      state.error && h('div', { class: 'error' }, state.error),
      list,
      ),
    )
    list.scrollTop = scroll
    const again = key && root.querySelector(`[data-key="${CSS.escape(key)}"]`)
    if (again) (again.focus(), again.setSelectionRange?.(caret[0], caret[1]))
  }

  // Only shown on your own comments (server says `mine`); the API enforces it too.
  const remove = (id, question) => (e) => {
    e.stopPropagation()
    if (confirm(question)) act(() => api(`/${id}`, { method: 'DELETE' }))()
  }

  function card(t, index) {
    const nameInput = nameField(`name:${t.id}`)
    const ta = h('textarea', {
      rows: 2,
      maxlength: 5000,
      placeholder: T.replyPh,
      'data-key': `reply:${t.id}`,
      value: drafts.get(t.id) ?? '',
      oninput: (e) => drafts.set(t.id, e.target.value),
    })
    const send = act(async () => {
      if (!ta.value.trim()) return ta.focus()
      await api('', { method: 'POST', body: { parent_id: t.id, author: author(nameInput), body: ta.value } })
      drafts.delete(t.id)
    })
    ta.addEventListener('keydown', submitOnCmdEnter(send))
    // Resolving is the AI agent's job (MCP resolve_comment, enforced by the API); people can only reopen.
    const reopen = act(() => api(`/${t.id}`, { method: 'PATCH', body: { status: 'open' } }))

    return h(
      'article',
      {
        class: `card${t.id === state.active ? ' active' : ''}`,
        'data-id': t.id,
        onclick: (e) => e.target.closest('textarea, input, button') || focusThread(t.id),
      },
      h(
        'div',
        { class: 'meta' },
        h('span', { class: `num${t.status === 'open' ? '' : ' done'}` }, t.status === 'open' ? index + 1 : '✓'),
        h('b', {}, t.author),
        h('time', { datetime: t.created_at, title: new Date(t.created_at).toLocaleString() }, ago(t.created_at)),
      ),
      h('p', { class: 'body' }, t.body),
      t.text_snippet && h('p', { class: 'snippet', title: t.text_snippet }, `“${t.text_snippet}”`),
      state.scope === 'all' && h('p', { class: 'page', title: t.url }, t.url === state.url ? `${t.url} · ${T.here}` : `${t.url} ↗`),
      t.url === state.url && !anchorOf(t) && h('p', { class: 'warn' }, T.missing),
      t.screenshot &&
        h('a', { href: `${API}/${t.id}/screenshot`, target: '_blank', rel: 'noopener', class: 'shot' },
          h('img', { src: `${API}/${t.id}/screenshot`, alt: T.screenshot, loading: 'lazy' })),
      t.replies.map((r) =>
        h(
          'div',
          { class: `reply${r.by_agent ? ' agent' : ''}` },
          h(
            'div',
            { class: 'meta' },
            r.by_agent ? '🤖' : null,
            h('b', {}, r.author),
            h('time', { datetime: r.created_at }, ago(r.created_at)),
            r.mine && h('button', { class: 'link danger', title: T.delete, onclick: remove(r.id, T.confirmDeleteReply) }, T.delete),
          ),
          h('p', { class: 'body' }, r.body),
        ),
      ),
      h(
        'div',
        { class: 'replybox' },
        nameInput,
        ta,
        h(
          'div',
          { class: 'row' },
          t.mine && h('button', { class: 'danger', onclick: remove(t.id, T.confirmDelete) }, T.delete),
          t.status === 'resolved' && h('button', { onclick: reopen }, T.reopen),
          h('button', { class: 'primary', onclick: send }, T.reply),
        ),
      ),
    )
  }

  // ---- polling + SPA navigation ----
  setInterval(() => {
    attach()
    const url = pageKey(location)
    if (url !== state.url) {
      Object.assign(state, { url, threads: [], active: null })
      lastJson = ''
      closeComposer()
      render()
      load()
    }
    position() // layout can shift without scroll (HMR, async content)
  }, 1000)
  // Push via long-poll: the proxy holds /changes until anyone (a reviewer or the AI agent) writes, then we refetch at once.
  // Not SSE/EventSource: Cloudflare Quick Tunnels buffer SSE. Polling stays as the fallback, slowed while this is healthy.
  let version = -1
  let liveUntil = 0
  ;(async function watchChanges() {
    for (;;) {
      try {
        const res = await fetch(`/__sp/api/changes?since=${version}`)
        if (res.status === 401) return // load() already shows the token banner
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const next = (await res.json()).version
        liveUntil = Date.now() + 60_000 // a held request lasts ≤ 25s
        if (version !== -1 && next !== version && !document.hidden) load()
        version = next
      } catch {
        liveUntil = 0
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
  })()
  setInterval(() => {
    const live = Date.now() < liveUntil
    if (!document.hidden && Date.now() - lastLoad >= (live ? SAFETY_POLL_MS : POLL_MS)) load()
  }, POLL_MS)
  document.addEventListener('visibilitychange', () => document.hidden || load())

  render()
  load().then(() => {
    const id = session.get('sp_focus')
    if (id) (session.set('sp_focus', ''), focusThread(id))
  })
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') mount()
