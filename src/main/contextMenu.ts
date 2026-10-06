// Right-click menu. Electron has none by default: copy/paste, spelling suggestions, links and images.
import { BrowserWindow, clipboard, Menu, shell, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron'

type Params = Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'misspelledWord' | 'dictionarySuggestions' | 'linkURL' | 'mediaType' | 'srcURL' | 'editFlags' | 'x' | 'y'>

export interface ContextActions {
  replaceMisspelling: (word: string) => void
  addToDictionary: (word: string) => void
  copyImage: () => void
  inspect?: () => void
}

/** The menu for a right-click (pure, so it can be tested). */
export function contextMenuTemplate(p: Params, a: ContextActions): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  const sep = (): void => {
    if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' })
  }
  if (p.isEditable && p.misspelledWord) {
    const suggestions = p.dictionarySuggestions.slice(0, 5)
    for (const s of suggestions) items.push({ label: s, click: () => a.replaceMisspelling(s) })
    if (!suggestions.length) items.push({ label: 'No spelling suggestions', enabled: false })
    items.push({ label: 'Add to dictionary', click: () => a.addToDictionary(p.misspelledWord) })
    sep()
  }
  const link = /^https?:\/\//.test(p.linkURL) ? p.linkURL : ''
  if (link) {
    items.push({ label: 'Open link in browser', click: () => void shell.openExternal(link) })
    items.push({ label: 'Copy link address', click: () => clipboard.writeText(link) })
    sep()
  }
  if (p.mediaType === 'image' && p.srcURL) {
    items.push({ label: 'Copy image', click: a.copyImage })
    sep()
  }
  if (p.isEditable) {
    items.push(
      { role: 'undo', enabled: p.editFlags.canUndo },
      { role: 'redo', enabled: p.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: p.editFlags.canCut },
      { role: 'copy', enabled: p.editFlags.canCopy },
      { role: 'paste', enabled: p.editFlags.canPaste },
      { role: 'pasteAndMatchStyle', label: 'Paste as plain text', enabled: p.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: p.editFlags.canSelectAll }
    )
  } else if (p.selectionText.trim()) {
    items.push({ role: 'copy' })
  }
  if (a.inspect) {
    sep()
    items.push({ label: 'Inspect element', click: a.inspect })
  }
  while (items.length && items[items.length - 1].type === 'separator') items.pop()
  return items
}

export function attachContextMenu(win: BrowserWindow, dev: boolean): void {
  const wc = win.webContents
  wc.on('context-menu', (_e, params) => {
    const template = contextMenuTemplate(params, {
      replaceMisspelling: (w) => wc.replaceMisspelling(w),
      addToDictionary: (w) => wc.session.addWordToSpellCheckerDictionary(w),
      copyImage: () => wc.copyImageAt(params.x, params.y),
      inspect: dev ? () => wc.inspectElement(params.x, params.y) : undefined
    })
    if (template.length) Menu.buildFromTemplate(template).popup({ window: win })
  })
}
