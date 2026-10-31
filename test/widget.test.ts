import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
// @ts-expect-error plain JS module served as-is to the browser
import { areaRect, badgeTitle, belowViewport, isCommentShortcut, isEmbedded, serverUrl, shareTokenFrom, launcherLabel, nearestCorner, isToggleFabShortcut, pinVisibleUnderModal, widgetParent, countCloned, keepInCapture, cssPath, describe, describeArea, enclosing, findAnchor, h, nodes, pageBackground, pageKey, resolvedSince, seenKey, stripBadge, unseenResolved } from '../widget/widget.js'

function page(html: string) {
  const win = new Window({ url: 'http://localhost/' })
  win.document.body.innerHTML = html
  ;(globalThis as any).document = win.document // h() builds nodes in the current document
  return win.document as unknown as Document
}

test('cssPath round-trips: querySelector(cssPath(el)) === el', () => {
  const doc = page(`
    <main>
      <ul><li>a</li><li>b</li><li><span>c</span><span>d</span></li></ul>
      <section id="hero"><h1>Title</h1><p>one</p><p>two</p></section>
      <div data-testid="save-row"><button>Save</button><button>Cancel</button></div>
    </main>`)
  for (const el of doc.querySelectorAll('body *')) {
    const sel = cssPath(el)
    assert.equal(doc.querySelector(sel), el, `${sel} should select <${el.localName}>${el.textContent?.slice(0, 10)}`)
  }
})

test('cssPath prefers stable anchors: id, data-testid', () => {
  const doc = page(`<section id="hero"><p>x</p><p>y</p></section><div data-testid="row"><button>A</button></div>`)
  assert.equal(cssPath(doc.querySelector('#hero p:nth-of-type(2)')!), '#hero > p:nth-of-type(2)')
  assert.equal(cssPath(doc.querySelector('button')!), '[data-testid="row"] > button')
})

test('cssPath skips generated ids (React useId, numeric) and duplicate ids', () => {
  const doc = page(`<div id=":r1:"><b>a</b></div><div id="«r2»"><i>b</i></div><div id="123"><u>c</u></div>
    <p id="dup">1</p><p id="dup">2</p>`)
  for (const s of ['b', 'i', 'u']) assert.doesNotMatch(cssPath(doc.querySelector(s)!), /#/, s)
  const second = doc.querySelectorAll('p')[1]
  assert.doesNotMatch(cssPath(second), /#dup/)
  assert.equal(doc.querySelector(cssPath(second)), second)
})

test('describe captures selector, trimmed text/html and click position in % of the element', () => {
  const doc = page(`<button class="cta">  Đăng   ký\n ngay  </button>`)
  const btn = doc.querySelector('button')!
  btn.getBoundingClientRect = () => ({ left: 100, top: 50, width: 200, height: 40 }) as DOMRect
  const d = describe(btn, 150, 60)
  assert.equal(d.selector, 'body > button')
  assert.equal(d.text_snippet, 'Đăng ký ngay')
  assert.match(d.html_snippet, /^<button class="cta">/)
  assert.equal(d.pos_x, 25)
  assert.equal(d.pos_y, 25)
})

test('describe keeps snippets inside API limits', () => {
  const doc = page(`<div>${'chữ '.repeat(500)}</div>`)
  const d = describe(doc.querySelector('div')!, 0, 0)
  assert.ok(d.text_snippet.length <= 200)
  assert.ok(d.html_snippet.length <= 2000)
  assert.equal(d.pos_x, 0) // zero-size rect must not produce NaN
})

test('h() renders untrusted strings as text, never HTML', () => {
  page('')
  const el = h('p', { class: 'body' }, '<img src=x onerror="alert(1)">', h('b', {}, 'ok'))
  assert.equal(el.querySelector('img'), null)
  assert.equal(el.textContent, '<img src=x onerror="alert(1)">ok')
  assert.equal(el.className, 'body')
})

test('nodes() drops null/false/undefined so replaceChildren never prints "null"', () => {
  const doc = page('<div></div>')
  const div = doc.querySelector('div')!
  div.replaceChildren(...nodes('💬', null, false, undefined, [h('b', {}, 1), null]))
  assert.equal(div.textContent, '💬1')
})

test('findAnchor returns the element, or null for missing/invalid selectors', () => {
  const doc = page(`<p>x</p>`)
  assert.equal(findAnchor(doc, { selector: 'body > p' }), doc.querySelector('p'))
  assert.equal(findAnchor(doc, { selector: 'body > h1' }), null)
  assert.equal(findAnchor(doc, { selector: '>>>bad' }), null)
  assert.equal(findAnchor(doc, { selector: null }), null)
})

test('pageKey is pathname + search (keeps basePath, drops hash and the share token)', () => {
  assert.equal(pageKey(new URL('https://x.trycloudflare.com/qtw-project-manager/tasks?tab=2#top')), '/qtw-project-manager/tasks?tab=2')
  assert.equal(pageKey(new URL('https://x/a?sp=secret&tab=1')), '/a?tab=1')
})

test('pageBackground: <html> colour, else <body>, else white (so dark pages are not captured on white)', () => {
  const doc = page('')
  doc.documentElement.style.backgroundColor = 'rgb(22, 23, 29)'
  assert.equal(pageBackground(doc), 'rgb(22, 23, 29)')
  doc.documentElement.style.backgroundColor = 'transparent'
  doc.body.style.backgroundColor = 'rgb(1, 2, 3)'
  assert.equal(pageBackground(doc), 'rgb(1, 2, 3)')
  doc.body.style.backgroundColor = ''
  assert.equal(pageBackground(doc), '#ffffff')
})

const thread = (selector: string | null, text_snippet: string | null) => ({ selector, text_snippet })

test('findAnchor: selector still right → that element', () => {
  const doc = page(`<ul><li>Một</li><li>Hai</li></ul>`)
  assert.equal(findAnchor(doc, thread('body > ul > li:nth-of-type(2)', 'Hai'))?.textContent, 'Hai')
})

test('findAnchor: DOM shifted so the selector silently points at the wrong element → found by text', () => {
  const doc = page(`<ul><li>Mới thêm</li><li>Một</li><li>Hai</li></ul>`) // "Hai" used to be li:nth-of-type(2)
  assert.equal(findAnchor(doc, thread('body > ul > li:nth-of-type(2)', 'Hai'))?.textContent, 'Hai')
})

test('findAnchor: selector gone, unique text → innermost element with that text', () => {
  const doc = page(`<section><div><button><span>Lưu thay đổi</span></button></div></section>`)
  assert.equal(findAnchor(doc, thread('#old-id', 'Lưu thay đổi'))?.localName, 'span')
})

test('findAnchor: the fix changed the wording → keep the selector element', () => {
  const doc = page(`<button id="save">Lưu lại</button>`)
  assert.equal(findAnchor(doc, thread('#save', 'Lưu'))?.id, 'save')
})

test('findAnchor: text compare ignores case/whitespace (innerText applies text-transform)', () => {
  const doc = page(`<p>x</p><h2>  Tiến   độ dự án </h2>`)
  assert.equal(findAnchor(doc, thread('body > h1', 'TIẾN ĐỘ DỰ ÁN'))?.localName, 'h2')
})

test('findAnchor: ambiguous text and no selector match → null (no guessing)', () => {
  const doc = page(`<button>Lưu</button><button>Lưu</button>`)
  assert.equal(findAnchor(doc, thread('#gone', 'Lưu')), null)
})

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect

test('area: anchored to the smallest ancestor that contains the whole dragged box', () => {
  const doc = page(`<main><section><button id="a">A</button><button id="b">B</button></section></main>`)
  const at = (sel: string, r: DOMRect) => ((doc.querySelector(sel)!.getBoundingClientRect = () => r), r)
  at('main', rect(0, 0, 1000, 800))
  at('section', rect(100, 100, 400, 100))
  at('#a', rect(110, 110, 100, 40))
  at('#b', rect(300, 110, 100, 40))
  const box = rect(150, 105, 200, 50) // spans both buttons
  const anchor = enclosing(doc.querySelector('#a')!, box)
  assert.equal(anchor.localName, 'section')
  const d = describeArea(anchor, box)
  assert.deepEqual([d.pos_x, d.pos_y, d.area_w, d.area_h], [12.5, 5, 50, 50])
  assert.equal(d.selector, 'body > main > section')
  // and back: same box in viewport coords from the anchor's current rect
  const back = areaRect(anchor.getBoundingClientRect(), d)
  assert.deepEqual([back.left, back.top, back.width, back.height], [150, 105, 200, 50])
})

test('area: box bigger than everything → body', () => {
  const doc = page(`<p>x</p>`)
  doc.querySelector('p')!.getBoundingClientRect = () => rect(0, 0, 10, 10)
  assert.equal(enclosing(doc.querySelector('p')!, rect(0, 0, 5000, 5000)).localName, 'body')
})

// Screenshot cost is ~1ms per cloned node on the main thread: a 9.7k-element page froze the tab for 13s.
test('screenshot clones only what can be in the picture: elements entirely below the viewport become empty shells', () => {
  const doc = page(`<header id="h"><b>top</b></header><main><p id="seen">x</p><ul id="list"><li>1</li><li>2</li><li>3</li></ul></main>`)
  const at = (sel: string, top: number) => (doc.querySelector(sel)!.getBoundingClientRect = () => ({ top }) as DOMRect)
  at('#h', 0)
  at('main', 50)
  at('#seen', 60)
  at('#list', 2000) // far below an 800px viewport
  const shell = (n: Element) => belowViewport(n, 800)
  assert.equal(shell(doc.querySelector('#list')!), true)
  assert.equal(shell(doc.querySelector('#seen')!), false)
  assert.equal(shell(doc.body), false, 'never body/html')
  // #list itself stays (removing whole rows/sections broke a real table's rendering), its 3 <li> are not visited
  assert.equal(countCloned(doc.body, shell), 5)
  assert.equal(keepInCapture(doc.querySelector('#list')!, 800), true)
  assert.equal(keepInCapture(doc.querySelector('#list li')!, 800), false)
  assert.equal(keepInCapture(doc.querySelector('#seen')!, 800), true)
})

// Telling reviewers when the AI resolved *their* comment.
const th = (id: string, status: string, mine = true, resolved_at: string | null = status === 'resolved' ? '2026-10-30T01:00:00Z' : null) =>
  ({ id, status, mine, resolved_at, url: '/', replies: [] })

test('resolvedSince: only my threads that went open → resolved between two loads', () => {
  const prev = new Map([['a', 'open'], ['b', 'open'], ['c', 'resolved'], ['d', 'open']])
  const next = [th('a', 'resolved'), th('b', 'open'), th('c', 'resolved'), th('d', 'resolved', false), th('e', 'resolved')]
  assert.deepEqual(resolvedSince(prev, next).map((t) => t.id), ['a'], 'not b (still open), c (already), d (not mine), e (never seen open)')
})

test('unseen resolutions are keyed by id + resolved_at, so a re-resolve after reopening is new again', () => {
  const seen = new Set([seenKey(th('a', 'resolved'))])
  assert.deepEqual(unseenResolved([th('a', 'resolved'), th('b', 'resolved'), th('c', 'open'), th('d', 'resolved', false)], seen).map((t) => t.id), ['b'])
  const again = th('a', 'resolved', true, '2026-10-30T05:00:00Z')
  assert.deepEqual(unseenResolved([again], seen).map((t) => t.id), ['a'])
})

test('tab title badge is added and removed without eating the app title', () => {
  assert.equal(badgeTitle('Quản lý dự án', 2), '(2) ✓ Quản lý dự án')
  assert.equal(badgeTitle('(2) ✓ Quản lý dự án', 3), '(3) ✓ Quản lý dự án', 'never stacks')
  assert.equal(stripBadge('(3) ✓ Quản lý dự án'), 'Quản lý dự án')
  assert.equal(stripBadge('(3) Inbox'), '(3) Inbox', "the app's own counters are left alone")
})

test('C starts commenting from anywhere, but never while typing, with modifiers, on repeat or mid-IME', () => {
  const doc = page(`<input id="i"><textarea id="t"></textarea><select id="s"><option>a</option></select><div id="e" contenteditable="true"></div><p id="p">x</p>`)
  const key = (init: Record<string, unknown>, target = doc.querySelector('#p')!) => ({ key: 'c', code: 'KeyC', ctrlKey: false, metaKey: false, altKey: false, repeat: false, isComposing: false, target, ...init })
  assert.equal(isCommentShortcut(key({})), true)
  assert.equal(isCommentShortcut(key({ key: 'C' })), true, 'caps lock / shift')
  assert.equal(isCommentShortcut(key({ key: 'с', code: 'KeyC' })), true, 'Cyrillic layout: physical C key')
  for (const sel of ['#i', '#t', '#s', '#e']) assert.equal(isCommentShortcut(key({}, doc.querySelector(sel)!)), false, `typing in ${sel}`)
  assert.equal(isCommentShortcut(key({ metaKey: true })), false, '⌘C is copy')
  assert.equal(isCommentShortcut(key({ ctrlKey: true })), false, 'Ctrl+C is copy')
  assert.equal(isCommentShortcut(key({ altKey: true })), false)
  assert.equal(isCommentShortcut(key({ repeat: true })), false, 'holding the key')
  assert.equal(isCommentShortcut(key({ isComposing: true })), false, 'IME (e.g. Vietnamese Telex) composing')
  assert.equal(isCommentShortcut(key({ key: 'x', code: 'KeyX' })), false)
})

// Native <dialog>.showModal() (used by the qtw app) puts the dialog in the top layer and makes everything outside
// it inert: the widget must live inside the open modal to stay visible and clickable.
test('widgetParent: the open modal dialog if there is one, else <body>', () => {
  const doc = page(`<dialog id="d"><p>x</p></dialog>`)
  assert.equal(widgetParent(doc), doc.body)
  const modal = doc.querySelector('dialog')!
  assert.equal(widgetParent({ body: doc.body, querySelector: (s: string) => (s === 'dialog:modal' ? modal : null) } as unknown as Document), modal)
  // engines without :modal throw on the selector: fall back to <body>, never crash
  assert.equal(widgetParent({ body: doc.body, querySelector: () => { throw new SyntaxError('bad selector') } } as unknown as Document), doc.body)
})

test('pinVisibleUnderModal: with a modal open only anchors inside it get pins', () => {
  const doc = page(`<main><p id="bg">behind</p></main><dialog id="d"><p id="in">inside</p></dialog>`)
  const d = doc.querySelector('dialog')!
  assert.equal(pinVisibleUnderModal(doc.querySelector('#bg')!, null), true, 'no modal: everything')
  assert.equal(pinVisibleUnderModal(doc.querySelector('#bg')!, d), false, 'behind the backdrop')
  assert.equal(pinVisibleUnderModal(doc.querySelector('#in')!, d), true)
})

test('⌥/Alt+C toggles the floating button; plain C still means "comment"', () => {
  const doc = page(`<input id="i"><p id="p">x</p>`)
  const key = (init: Record<string, unknown>, target = doc.querySelector('#p')!) =>
    ({ key: 'ç', code: 'KeyC', ctrlKey: false, metaKey: false, altKey: true, repeat: false, isComposing: false, target, ...init })
  assert.equal(isToggleFabShortcut(key({})), true, 'mac Option+C types ç: matched by code')
  assert.equal(isToggleFabShortcut(key({ key: 'c' })), true, 'Windows/Linux Alt+C')
  assert.equal(isToggleFabShortcut(key({ altKey: false, key: 'c' })), false)
  assert.equal(isCommentShortcut(key({})), false, 'Alt+C is not the comment shortcut')
  assert.equal(isToggleFabShortcut(key({}, doc.querySelector('#i')!)), false, 'not while typing')
  assert.equal(isToggleFabShortcut(key({ metaKey: true })), false)
  assert.equal(isToggleFabShortcut(key({ repeat: true })), false)
})

// Launcher in the style of the Next.js dev-tools indicator: a pill you can drag to any corner.
test('nearestCorner: the quadrant of the release point', () => {
  assert.equal(nearestCorner(10, 10, 1000, 800), 'tl')
  assert.equal(nearestCorner(990, 10, 1000, 800), 'tr')
  assert.equal(nearestCorner(10, 790, 1000, 800), 'bl')
  assert.equal(nearestCorner(990, 790, 1000, 800), 'br')
  assert.equal(nearestCorner(500, 400, 1000, 800), 'br', 'dead centre goes to the default corner')
})

test('launcherLabel: like "1 Issue · 1 Insight", empty when nothing to report', () => {
  assert.equal(launcherLabel(0, 0), '')
  assert.equal(launcherLabel(3, 0), '3 góp ý')
  assert.equal(launcherLabel(3, 1), '3 góp ý · 1 mới')
  assert.equal(launcherLabel(0, 2), '2 mới')
})

// Embed mode: the widget is loaded from the shared-pro server by another site, so every request goes to the origin
// the script came from, and the reviewer's share token comes from ?sp= on the site's URL (no third-party cookies).
test('serverUrl: API/vendor paths resolve against the script origin, not the page', () => {
  assert.equal(serverUrl('/__sp/api/comments', 'https://review.example.com/__sp/widget.js'), 'https://review.example.com/__sp/api/comments')
  assert.equal(serverUrl('/__sp/api/comments', 'http://localhost:3100/__sp/widget.js'), 'http://localhost:3100/__sp/api/comments')
})

test('isEmbedded: script origin differs from the page origin', () => {
  assert.equal(isEmbedded('https://review.example.com/__sp/widget.js', 'https://staging.example.com'), true)
  assert.equal(isEmbedded('http://localhost:3100/__sp/widget.js', 'http://localhost:3100'), false, 'proxy mode')
})

test('shareTokenFrom: the ?sp= value of the page URL, or null', () => {
  assert.equal(shareTokenFrom('https://staging.example.com/dashboard?tab=2&sp=abc_DEF-123'), 'abc_DEF-123')
  assert.equal(shareTokenFrom('https://staging.example.com/dashboard'), null)
  assert.equal(shareTokenFrom('https://staging.example.com/?sp=%3Cscript%3E'), null, 'only token-shaped values')
})
