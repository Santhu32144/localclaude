// Remembers the window's size, position and maximized state between launches.
import type { BrowserWindow, Rectangle } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export const DEFAULT_WINDOW: WindowState = { width: 1280, height: 860, maximized: false }

export function loadWindowState(file: string): WindowState {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as Partial<WindowState>
    if (typeof s.width === 'number' && typeof s.height === 'number') return { ...DEFAULT_WINDOW, ...s }
  } catch {
    /* first launch or unreadable */
  }
  return DEFAULT_WINDOW
}

/**
 * Keep the saved size, and the position only if at least 100×60 px of the window's top
 * would be on a screen (monitors change between launches).
 */
export function fitToScreens(s: WindowState, workAreas: Rectangle[], min = { width: 760, height: 520 }): WindowState {
  const width = Math.max(min.width, Math.min(s.width, Math.max(...workAreas.map((w) => w.width), min.width)))
  const height = Math.max(min.height, Math.min(s.height, Math.max(...workAreas.map((w) => w.height), min.height)))
  const out: WindowState = { width, height, maximized: s.maximized }
  if (s.x === undefined || s.y === undefined) return out
  const visible = workAreas.some((w) => {
    const ix = Math.min(s.x! + width, w.x + w.width) - Math.max(s.x!, w.x)
    const iy = Math.min(s.y! + 60, w.y + w.height) - Math.max(s.y!, w.y)
    return ix >= 100 && iy >= 60
  })
  return visible ? { ...out, x: s.x, y: s.y } : out
}

export function trackWindowState(win: BrowserWindow, file: string): void {
  let timer: NodeJS.Timeout | undefined
  const save = (): void => {
    if (win.isDestroyed() || win.isMinimized()) return
    const b = win.getNormalBounds()
    try {
      writeFileSync(file, JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() }))
    } catch {
      /* not worth failing over */
    }
  }
  const later = (): void => {
    clearTimeout(timer)
    timer = setTimeout(save, 400)
  }
  win.on('resize', later)
  win.on('move', later)
  win.on('maximize', save)
  win.on('unmaximize', save)
  win.on('close', () => {
    clearTimeout(timer)
    save()
  })
}
