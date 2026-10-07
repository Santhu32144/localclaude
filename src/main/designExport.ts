// Exports a design as PDF or PNG: the page is rendered in a hidden, sandboxed window
// (no preload, no access to the app) from a temporary file, then printed or captured.
import { BrowserWindow, app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Chromium can't capture taller images than this in one go. */
const MAX_PNG_PX = 16000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Load the page and wait for its scripts, images and web fonts (but not forever). */
async function load(win: BrowserWindow, file: string): Promise<void> {
  const wc = win.webContents
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (e) => e.preventDefault())
  await Promise.race([win.loadFile(file), sleep(20_000)])
  await Promise.race([wc.executeJavaScript('document.fonts.ready.then(() => true)'), sleep(5_000)]).catch(() => {})
  // animations and late layout settle
  await sleep(400)
}

/** `height`: a device's screen height, so a short page still fills the screen in a PNG. */
export async function exportDesign(page: string, opts: { format: 'pdf' | 'png'; width: number; height?: number; slides?: boolean }): Promise<Buffer> {
  const dir = join(app.getPath('temp'), 'localclaude-design-export')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, randomUUID() + '.html')
  writeFileSync(file, page)
  const win = new BrowserWindow({
    show: false,
    width: opts.width,
    height: opts.height || 900,
    useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: opts.format === 'png' }
  })
  try {
    // Windows fits a new window's size to the screen; setting it again isn't limited that way
    win.setContentSize(opts.width, opts.height || 900)
    await load(win, file)
    const wc = win.webContents
    if (opts.format === 'pdf') {
      return await wc.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        // slides are 1920×1080 px; other pages say their size in CSS, or get A4
        pageSize: opts.slides ? { width: 20, height: 11.25 } : 'A4',
        margins: { top: 0, bottom: 0, left: 0, right: 0 }
      })
    }
    // the whole page (or the screen, when the page is shorter), at twice the pixels when it fits
    const [pageH, screenH] = (await wc.executeJavaScript('[Math.ceil(document.documentElement.scrollHeight), innerHeight]')) as number[]
    const height = Math.max(200, Math.min(MAX_PNG_PX, pageH > screenH + 1 ? pageH : opts.height || 900))
    const scale = height * 2 <= MAX_PNG_PX ? 2 : 1
    win.setContentSize(opts.width * scale, height * scale)
    wc.setZoomFactor(scale)
    await sleep(500)
    // exactly the page (the window can come out a pixel larger)
    return (await wc.capturePage({ x: 0, y: 0, width: opts.width * scale, height: height * scale })).toPNG()
  } finally {
    win.destroy()
    rmSync(file, { force: true })
  }
}
