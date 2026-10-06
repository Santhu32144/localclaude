// End-to-end tests: the real app (main process, preload and UI from out/) with a scripted Claude
// (LOCALCLAUDE_FAKE_AGENT), a throwaway profile, and file dialogs answered by the steps.
// Run with `npm run test:e2e`. Pass a step name to run up to and including it.
import { app, BrowserWindow, dialog } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { steps } from './steps.mjs'

const work = mkdtempSync(join(tmpdir(), 'lc-e2e-'))
process.env.LOCALCLAUDE_USER_DATA = join(work, 'profile')
process.env.LOCALCLAUDE_FAKE_AGENT = '1'
process.env.LOCALCLAUDE_TEST_MODE = '1'

// File dialogs take their answers from this queue, in order.
const answers = []
dialog.showSaveDialog = async () => {
  const a = answers.shift()
  return a ? { canceled: false, filePath: a } : { canceled: true }
}
dialog.showOpenDialog = async () => {
  const a = answers.shift()
  return a ? { canceled: false, filePaths: [].concat(a) } : { canceled: true, filePaths: [] }
}

await import(pathToFileURL(resolve('out/main/index.js')).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const HELPERS = `window.__t = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  byText: (sel, text) => [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(text)),
  click: (el) => { if (!el) throw new Error('nothing to click'); el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el.click(); return true },
  setValue: (el, v) => {
    if (!el) throw new Error('no input')
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  },
  key: (el, key, o = {}) => { (el || window).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...o })); return true },
  text: (s) => document.querySelector(s)?.textContent ?? ''
}; true`

app.whenReady().then(async () => {
  let win
  for (let i = 0; i < 100 && !(win = BrowserWindow.getAllWindows()[0]); i++) await sleep(100)
  const wc = win.webContents
  if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r))
  const page = (js) => wc.executeJavaScript(js)
  await page(HELPERS)

  /** Poll a page expression until it's truthy. */
  const waitFor = async (desc, js, timeout = 10000) => {
    const t0 = Date.now()
    let last
    while (Date.now() - t0 < timeout) {
      try {
        last = await page(js)
        if (last) return last
      } catch (e) {
        last = String(e)
      }
      await sleep(100)
    }
    const dom = await page("(document.querySelector('.main')?.innerText ?? '').slice(0, 600)").catch(() => '')
    throw new Error(`timed out waiting for ${desc} (last: ${JSON.stringify(last)})\n--- screen text ---\n${dom}`)
  }

  const ctx = {
    page,
    waitFor,
    sleep,
    answers,
    work,
    file: (name) => join(work, name),
    exists: existsSync,
    read: (p) => readFileSync(p),
    write: (p, d) => writeFileSync(p, d),
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    /** Save a screenshot when LOCALCLAUDE_E2E_SHOTS names a folder. */
    shot: async (name) => {
      const dir = process.env.LOCALCLAUDE_E2E_SHOTS
      if (!dir) return
      mkdirSync(dir, { recursive: true })
      await sleep(300)
      writeFileSync(join(dir, name + '.png'), (await wc.capturePage()).toPNG())
    },
    /** Send a message in the open chat and wait for Claude's reply to contain `expect`. */
    send: async (text, expect) => {
      await waitFor('composer', "!!__t.q('.composer-input') && !__t.q('.send.stop')")
      await page(`__t.setValue(__t.q('.composer-input'), ${JSON.stringify(text)})`)
      await page("__t.key(__t.q('.composer-input'), 'Enter')")
      if (expect) await waitFor(`reply "${expect}"`, `[...document.querySelectorAll('.turn')].some((t) => t.innerText.includes(${JSON.stringify(expect)})) && !__t.q('.send.stop')`, 15000)
    },
    openSettings: async (tab) => {
      await page("__t.key(window, ',', { ctrlKey: true })")
      await waitFor('settings', "!!__t.q('.modal')")
      await page(`__t.click(__t.byText('.nav-item', ${JSON.stringify(tab)}))`)
    },
    closeModal: async () => {
      await page("__t.key(window, 'Escape')")
      await waitFor('modal closed', "!__t.q('.modal-backdrop')")
    },
    menuItem: async (label) => {
      await waitFor(`menu item "${label}"`, `!!__t.byText('.menu-item', ${JSON.stringify(label)})`)
      await page(`__t.click(__t.byText('.menu-item', ${JSON.stringify(label)}))`)
    }
  }

  const only = process.argv.find((a) => !a.startsWith('-') && !a.endsWith('.mjs') && !a.includes('electron') && steps.some((s) => s.name === a))
  let passed = 0
  let failed = 0
  for (const s of steps) {
    const t0 = Date.now()
    try {
      await s.run(ctx)
      passed++
      console.log(`✓ ${s.name} (${Date.now() - t0} ms)`)
    } catch (e) {
      failed++
      console.log(`✗ ${s.name}\n  ${String(e?.stack ?? e).split('\n').join('\n  ')}`)
      break
    }
    if (only && s.name === only) break
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* files may still be open on Windows */
  }
  app.exit(failed ? 1 : 0)
})
