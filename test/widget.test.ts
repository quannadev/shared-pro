import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
// @ts-expect-error plain JS module served as-is to the browser
import { cssPath, describe, findAnchor, h, nodes, pageKey } from '../widget/widget.js'

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
