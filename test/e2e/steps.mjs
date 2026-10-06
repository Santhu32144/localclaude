// End-to-end steps, run in order against one app instance (see run.mjs). Each step drives the real UI.
import { join } from 'node:path'
import { makeDocx, makePdf, mcpServerScript } from './files.mjs'

const lastTurnId = "(__t.qa('.turn').at(-1)?.dataset.turn ?? '')"

export const steps = [
  {
    name: 'boots with no chats',
    run: async ({ waitFor, page }) => {
      await waitFor('sidebar', "!!__t.q('.side-new')")
      if (await page("__t.qa('.session-item').length")) throw new Error('expected no chats')
    }
  },
  {
    name: 'new chat gets a streamed reply',
    run: async (c) => {
      await c.page("__t.click(__t.q('.side-new'))")
      await c.send('hello there', 'Echo: hello there')
    }
  },
  {
    name: 'chat gets an AI title',
    run: (c) => c.waitFor('AI title', "__t.qa('.session-title').some((e) => e.textContent.startsWith('Chat about hello'))")
  },
  {
    name: 'edit a message and resend it',
    run: async (c) => {
      const before = await c.page("__t.q('.msg-user').dataset.msg")
      await c.page(`__t.click(__t.q('.msg-user .msg-actions button[title="Edit and resend"]'))`)
      await c.waitFor('editor', "!!__t.q('.edit-input')")
      await c.page("__t.setValue(__t.q('.edit-input'), 'hello again')")
      await c.page("__t.click(__t.byText('.bubble.editing .btn', 'Send'))")
      await c.waitFor('new reply', `__t.q('.msg-user')?.dataset.msg !== ${JSON.stringify(before)} && __t.qa('.turn').some((t) => t.innerText.includes('Echo: hello again')) && !__t.q('.send.stop')`, 15000)
      if ((await c.page("__t.qa('.msg-user').length")) !== 1) throw new Error('expected one message after editing')
      if (await c.page("document.querySelector('.messages').innerText.includes('Echo: hello there')")) throw new Error('the old reply is still shown')
    }
  },
  {
    name: 'retry the last reply',
    run: async (c) => {
      const before = await c.page(lastTurnId)
      await c.page(`__t.click(__t.q('.turn-actions button[title^="Retry"]'))`)
      await c.waitFor('a new reply', `${lastTurnId} !== ${JSON.stringify(before)} && __t.qa('.turn').at(-1).innerText.includes('Echo: hello again') && !__t.q('.send.stop')`, 15000)
      if ((await c.page("__t.qa('.turn').length")) !== 1) throw new Error('retry should replace the reply, not add one')
    }
  },
  {
    name: 'artifact opens in the side panel',
    run: async (c) => {
      await c.send('make artifact please', 'I made a demo page')
      await c.waitFor('artifact card', "!!__t.q('.artifact-chip')")
      await c.waitFor('panel with a preview', "!!__t.q('.artifact-panel .artifact-frame')")
      await c.shot("artifact-panel")
      await c.waitFor('artifact icon in the sidebar', "!!__t.q('.session-item .item-icon')")
      await c.page(`__t.click(__t.q('.artifact-head button[title="Close"]'))`)
      await c.waitFor('panel closed', "!__t.q('.artifact-panel')")
    }
  },
  {
    name: 'memory is saved and shown in settings',
    run: async (c) => {
      await c.send('remember my favorite color is teal', 'Noted.')
      await c.openSettings('Memory & data')
      await c.waitFor('memory item', "__t.text('.memory-list').includes('my favorite color is teal')")
      await c.closeModal()
    }
  },
  {
    name: 'permission prompt: allow once',
    run: async (c) => {
      await c.send('ask permission now')
      await c.waitFor('permission card', "!!__t.q('.perm-card')")
      await c.page("__t.click(__t.byText('.perm-card .btn', 'Allow once'))")
      await c.waitFor('command ran', "__t.qa('.turn').some((t) => t.innerText.includes('Permission granted')) && !__t.q('.send.stop')", 15000)
    }
  },
  {
    name: 'pick a response style',
    run: async (c) => {
      await c.page("__t.click(__t.q('.style-menu .menu-trigger'))")
      await c.menuItem('Concise')
      await c.waitFor('style shown', "__t.text('.style-menu .style-name') === 'Concise'")
      await c.shot("style-chosen")
    }
  },
  {
    name: 'usage page shows plan limits',
    run: async (c) => {
      await c.openSettings('Usage')
      await c.waitFor('usage rows', "__t.text('.usage').includes('Current session (5-hour limit)') && __t.text('.usage').includes('37% used')")
      await c.shot("usage")
      await c.closeModal()
    }
  },
  {
    name: 'file edit shows a diff card',
    run: async (c) => {
      await c.send('edit file please', 'Edited app.ts')
      await c.waitFor('file card', "__t.text('.file-card').includes('app.ts')")
    }
  },
  {
    name: 'the Files changed panel lists what Claude edited',
    run: async (c) => {
      await c.waitFor('files button', "__t.q('.files-btn .count-badge')?.textContent === '1'")
      await c.page("__t.click(__t.q('.files-btn'))")
      await c.waitFor('panel', "__t.text('.files-panel').includes('app.ts') && __t.text('.files-panel .artifact-head').includes('+1')")
      await c.page("__t.click(__t.q('.files-panel .file-card-head'))")
      await c.waitFor('the diff', "!!__t.q('.files-panel .diff-line.add') && !!__t.q('.files-panel .diff-line.del')")
      await c.page("__t.click(__t.byText('.files-panel .btn', 'Open in VS Code'))")
      await c.until('opened in the editor', () => c.opened.includes('vscode://file/C:/demo/app.ts'))
      await c.shot('files-changed')
      await c.page(`__t.click(__t.q('.files-panel .artifact-head button[title="Close"]'))`)
      await c.waitFor('closed', "!__t.q('.files-panel')")
    }
  },
  {
    name: 'stop a running reply',
    run: async (c) => {
      await c.page("__t.setValue(__t.q('.composer-input'), 'slow please'); __t.key(__t.q('.composer-input'), 'Enter')")
      await c.waitFor('working', "!!__t.q('.send.stop')")
      await c.page("__t.click(__t.q('.send.stop'))")
      await c.waitFor('stopped', "__t.qa('.sys-note').some((n) => n.textContent.includes('Stopped')) && !__t.q('.send.stop')")
      await c.shot("chat-after-stop")
    }
  },
  {
    name: 'Esc Esc opens rewind',
    run: async (c) => {
      await c.page("__t.key(__t.q('.composer-input'), 'Escape'); __t.key(__t.q('.composer-input'), 'Escape')")
      await c.waitFor('rewind dialog', "!!__t.q('.rewind-card')")
      await c.page("__t.key(window, 'Escape')")
      await c.waitFor('closed', "!__t.q('.rewind-card')")
    }
  },
  {
    name: 'export the chat as Markdown',
    run: async (c) => {
      const out = c.file('chat.md')
      c.answers.push(out)
      await c.page("__t.key(window, 'E', { ctrlKey: true, shiftKey: true })")
      await c.waitFor('export dialog', "!!__t.q('.export-dialog')")
      await c.page("__t.click(__t.byText('.export-dialog .btn', 'Export Markdown'))")
      await c.waitFor('exported', "__t.text('.export-dialog').includes('Exported')")
      const md = c.read(out).toString()
      if (!md.includes('## Claude') || !md.includes('Echo: hello again') || !md.includes('Demo page')) throw new Error('chat.md is missing content')
      await c.page("__t.click(__t.byText('.export-dialog .btn', 'Done'))")
    }
  },
  {
    name: 'export everything as a ZIP and import it back',
    run: async (c) => {
      const zip = c.file('all.zip')
      c.answers.push(zip)
      await c.page("__t.key(window, 'E', { ctrlKey: true, shiftKey: true })")
      await c.waitFor('export dialog', "!!__t.q('.export-dialog')")
      await c.page("__t.click(__t.byText('.export-scopes .option', 'Everything'))")
      await c.page("__t.click(__t.byText('.export-dialog .btn', 'Export ZIP'))")
      await c.waitFor('exported', "__t.text('.export-dialog').includes('Exported')")
      if (c.read(zip).subarray(0, 2).toString() !== 'PK') throw new Error('not a ZIP file')
      await c.page("__t.click(__t.byText('.export-dialog .btn', 'Done'))")
      c.answers.push(zip)
      await c.page("__t.click(__t.q('.side-titlebar .menu-trigger'))")
      await c.menuItem('Import an export or backup')
      await c.waitFor('import result', "__t.text('.toast').includes('Skipped')")
    }
  },
  {
    name: 'create a project and chat in it',
    run: async (c) => {
      await c.page("__t.click(__t.byText('.side-nav', 'Projects'))")
      await c.waitFor('projects page', "!!__t.byText('.page-head .btn', 'New project')")
      await c.page("__t.click(__t.byText('.page-head .btn', 'New project'))")
      await c.page("__t.setValue(__t.q('.project-form input'), 'E2E project')")
      await c.page("__t.click(__t.byText('.project-form .btn', 'Create project'))")
      await c.waitFor('project page', "__t.text('.project-title-row h1') === 'E2E project'")
      await c.page("__t.setValue(__t.q('.project-composer .composer-input'), 'hello project'); __t.key(__t.q('.project-composer .composer-input'), 'Enter')")
      await c.waitFor('chat in the project', "__t.text('.titlebar .crumb').includes('E2E project') && __t.qa('.turn').some((t) => t.innerText.includes('Echo: hello project'))", 15000)
    }
  },
  {
    name: 'pin a chat and collapse a group',
    run: async (c) => {
      await c.page("__t.click(__t.q('.session-item .more .menu-trigger'))")
      await c.menuItem('Pin')
      await c.waitFor('pinned section', "!!__t.byText('.side-section .group-label', 'Pinned')")
      await c.page("__t.click(__t.byText('.group-row .group-label', 'Today'))")
      await c.waitFor('Today collapsed', "__t.qa('.side-section.closed').some((s) => s.textContent.includes('Today'))")
      await c.page("__t.click(__t.byText('.group-row .group-label', 'Today'))")
      await c.waitFor('Today open', "!__t.qa('.side-section.closed').some((s) => s.textContent.includes('Today'))")
    }
  },
  {
    name: 'search inside messages from the sidebar',
    run: async (c) => {
      await c.page("__t.setValue(__t.q('.side-search input'), 'teal')")
      await c.waitFor('message hits', "!!__t.byText('.side-section .group-label', 'In messages') && !!__t.q('.search-hit .hit-snippet mark')")
      await c.shot('search-hits')
      await c.page("__t.click(__t.q('.search-hit'))")
      await c.waitFor('find bar with matches', "__t.q('.find-input')?.value === 'teal' && /^\\d+\\/\\d+$/.test(__t.text('.find-count'))")
      await c.waitFor('chat opened', "__t.qa('.turn').some((t) => t.innerText.includes('Noted.'))")
      await c.shot('find-in-chat')
      await c.page("__t.key(__t.q('.find-input'), 'Escape')")
      await c.waitFor('find bar closed', "!__t.q('.find-bar')")
      await c.page("__t.setValue(__t.q('.side-search input'), '')")
      await c.waitFor('chat list back', "!__t.q('.search-hit') && __t.qa('.session-item').length >= 2")
    }
  },
  {
    name: 'Ctrl+F finds text in the open chat',
    run: async (c) => {
      await c.page("__t.key(window, 'f', { ctrlKey: true })")
      await c.waitFor('find bar', "!!__t.q('.find-bar') && document.activeElement === __t.q('.find-input')")
      await c.page("__t.setValue(__t.q('.find-input'), 'not-in-this-chat')")
      await c.waitFor('no results', "__t.text('.find-count') === 'No results'")
      await c.page("__t.setValue(__t.q('.find-input'), 'please')")
      await c.waitFor('several matches', "/^1\\/[2-9]/.test(__t.text('.find-count'))")
      await c.page("__t.key(__t.q('.find-input'), 'Enter')")
      await c.waitFor('next match', "__t.text('.find-count').startsWith('2/')")
      await c.page("__t.key(__t.q('.find-input'), 'Enter', { shiftKey: true })")
      await c.waitFor('previous match', "__t.text('.find-count').startsWith('1/')")
      await c.page("__t.key(__t.q('.find-input'), 'Escape')")
      await c.waitFor('closed', "!__t.q('.find-bar')")
      // switching chats doesn't bring it back
      await c.page("__t.click(__t.qa('.session-item').find((e) => !e.classList.contains('active')))")
      await c.sleep(300)
      if (await c.page("!!__t.q('.find-bar')")) throw new Error('find bar reopened in another chat')
    }
  },
  {
    name: 'Claude searches earlier chats',
    run: async (c) => {
      await c.page("__t.click(__t.q('.side-new'))")
      await c.send('search my chats for teal', 'Found: [')
      const reply = await c.page("__t.qa('.turn').at(-1).innerText")
      if (!reply.includes('Chat about hello')) throw new Error('expected the chat that mentions teal, got: ' + reply)
      if (!reply.includes('Looked through past chats')) throw new Error('the step summary should say what Claude did, got: ' + reply)
      await c.shot('claude-searched-chats')
    }
  },
  {
    name: 'paste an image: Claude gets it and it shows in the chat',
    run: async (c) => {
      await c.page("__t.click(__t.q('.side-new'))")
      await c.waitFor('empty chat', "!__t.q('.msg-user') && !!__t.q('.composer-input')")
      await c.page(`(async () => {
        const cv = document.createElement('canvas'); cv.width = 320; cv.height = 200
        const g = cv.getContext('2d'); g.fillStyle = '#d97757'; g.fillRect(0, 0, 320, 200); g.fillStyle = '#fff'; g.fillRect(40, 40, 120, 80)
        const blob = await new Promise((r) => cv.toBlob(r, 'image/png'))
        const dt = new DataTransfer(); dt.items.add(new File([blob], 'square.png', { type: 'image/png' }))
        __t.q('.composer-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
        return true
      })()`)
      await c.waitFor('attachment preview', "!!__t.q('.attachments img')")
      await c.send('what is in this picture', 'Echo: what is in this picture (with 1 image)')
      await c.waitFor('thumbnail loaded', "(() => { const i = __t.q('.msg-user .user-images img'); return !!i && i.complete && i.naturalWidth === 320 })()")
      if (await c.page("!!__t.q('.attachments img')")) throw new Error('the composer should be empty after sending')
    }
  },
  {
    name: 'open an image full size and close it with Esc',
    run: async (c) => {
      await c.page("__t.click(__t.q('.msg-user .user-images .thumb'))")
      await c.waitFor('viewer', "(() => { const i = __t.q('.lightbox-img'); return !!i && i.complete && i.naturalWidth === 320 })()")
      if (!(await c.page("__t.text('.lightbox-bar').includes('320 × 200')"))) throw new Error('the viewer should show the size')
      await c.shot('lightbox')
      await c.page("__t.key(window, 'Escape')")
      await c.waitFor('viewer closed', "!__t.q('.lightbox')")
      await c.sleep(200)
      if (await c.page("!!__t.q('.rewind-card')")) throw new Error('Esc should only close the viewer')
    }
  },
  {
    name: 'editing a message sends its image again',
    run: async (c) => {
      await c.page(`__t.click(__t.q('.msg-user .msg-actions button[title="Edit and resend"]'))`)
      await c.waitFor('editor', "!!__t.q('.edit-input') && __t.text('.bubble.editing').includes('The images are sent again')")
      await c.page("__t.setValue(__t.q('.edit-input'), 'describe it again')")
      await c.page("__t.click(__t.byText('.bubble.editing .btn', 'Send'))")
      await c.waitFor('reply about the image', "__t.qa('.turn').some((t) => t.innerText.includes('Echo: describe it again (with 1 image)')) && !__t.q('.send.stop')", 15000)
      await c.waitFor('thumbnail still there', "(() => { const i = __t.q('.msg-user .user-images img'); return !!i && i.complete && i.naturalWidth === 320 })()")
    }
  },
  {
    name: 'a computer-use screenshot shows under the steps',
    run: async (c) => {
      await c.send('take a screenshot', 'Here is your screen.')
      await c.waitFor('screenshot preview', "(() => { const i = __t.q('.turn .screen-preview img'); return !!i && i.complete && i.naturalWidth > 0 })()")
      const w = await c.page("__t.q('.turn .screen-preview img').naturalWidth")
      if (w !== 480) throw new Error('expected the 480px thumbnail, got ' + w)
      await c.shot('screenshot-step')
      await c.page("__t.click(__t.q('.turn .screen-preview .thumb'))")
      await c.waitFor('full size in the viewer', "(() => { const i = __t.q('.lightbox-img'); return !!i && i.complete && i.naturalWidth === 640 })()")
      await c.page("__t.click(__t.q('.lightbox'))")
      await c.waitFor('closed by clicking outside', "!__t.q('.lightbox')")
    }
  },
  {
    name: 'back up everything with a password',
    run: async (c) => {
      const file = c.file('everything.lcbackup')
      await c.openSettings('Backups')
      await c.waitFor('backups tab', "__t.text('.modal-body h2') === 'Backups'")
      await c.page("__t.click(__t.byText('.modal-body .btn', 'Back up now…'))")
      await c.waitFor('password dialog', "!!__t.q('.password-dialog')")
      await c.page("(() => { const [a, b] = __t.qa('.password-dialog input'); __t.setValue(a, 'correct horse'); __t.setValue(b, 'correct horsf'); return true })()")
      await c.page("__t.click(__t.byText('.password-dialog .btn', 'Choose where to save'))")
      await c.waitFor('mismatch caught', "__t.text('.password-dialog').includes('don’t match')")
      await c.page("__t.setValue(__t.qa('.password-dialog input')[1], 'correct horse')")
      c.answers.push(file)
      await c.page("__t.click(__t.byText('.password-dialog .btn', 'Choose where to save'))")
      await c.waitFor('saved', "!__t.q('.password-dialog') && __t.text('.backup-note').includes('Saved the backup')", 20000)
      if (c.read(file).subarray(0, 6).toString() !== 'LCBK1\n') throw new Error('not an encrypted backup')
      if (c.read(file).includes('hello again')) throw new Error('chat text is readable in the backup')
    }
  },
  {
    name: 'restore a backup with its password',
    run: async (c) => {
      c.answers.push(c.file('everything.lcbackup'))
      await c.page("__t.click(__t.byText('.modal-body .btn', 'Restore from a backup…'))")
      await c.waitFor('password asked', "__t.text('.password-dialog').includes('Restore a backup')")
      await c.page("__t.setValue(__t.q('.password-dialog input'), 'wrong password')")
      await c.page("__t.click(__t.byText('.password-dialog .btn', 'Restore'))")
      await c.waitFor('wrong password', "__t.text('.password-dialog').includes('Wrong password')", 20000)
      await c.page("__t.setValue(__t.q('.password-dialog input'), 'correct horse')")
      await c.page("__t.click(__t.byText('.password-dialog .btn', 'Restore'))")
      await c.waitFor('restored', "!__t.q('.password-dialog') && __t.text('.toast').includes('already here')", 20000)
    }
  },
  {
    name: 'automatic backups go to a folder',
    run: async (c) => {
      const dir = c.file('auto-backups')
      c.mkdir(dir)
      await c.page("__t.click(__t.byText('.modal-body .toggle', 'Back up automatically').querySelector('input'))")
      await c.waitFor('asks for a password', "__t.text('.password-dialog').includes('Set a backup password')")
      await c.page("(() => { const [a, b] = __t.qa('.password-dialog input'); __t.setValue(a, 'battery staple'); __t.setValue(b, 'battery staple'); return true })()")
      await c.page("__t.click(__t.byText('.password-dialog .btn', 'Save password'))")
      await c.waitFor('password saved', "!__t.q('.password-dialog') && __t.text('.backup-auto').includes('Saved, encrypted')")
      c.answers.push(dir)
      await c.page("__t.click(__t.byText('.backup-auto .btn', 'Change'))")
      await c.waitFor('folder chosen', `__t.q('.backup-auto input').value === ${JSON.stringify(dir)}`)
      await c.page("__t.click(__t.byText('.backup-auto .btn', 'Back up to folder now'))")
      await c.waitFor('backed up', "__t.text('.backup-last').startsWith('Today')", 20000)
      const files = c.list(dir)
      if (files.length !== 1 || !/^LocalClaude backup .*\.lcbackup$/.test(files[0])) throw new Error('expected one backup in the folder, got ' + files.join(', '))
      await c.shot('backups')
      await c.closeModal()
    }
  },
  {
    name: 'project knowledge: PDF and Word files, and a linked folder Claude searches',
    run: async (c) => {
      const pdf = c.file('report.pdf')
      c.write(pdf, makePdf(['Quarterly revenue grew 12 percent', 'Page two mentions the giraffe budget']))
      const docx = c.file('launch.docx')
      c.write(docx, makeDocx(['Launch on Friday', 'Invite the okapi team']))
      const folder = c.file('field-notes')
      c.mkdir(folder)
      c.write(join(folder, 'trip.md'), '# Trip\n\nWe saw a zebra crossing the road.')
      await c.page("__t.click(__t.byText('.side-nav', 'Projects'))")
      await c.waitFor('project list', "!!__t.byText('.project-card', 'E2E project')")
      await c.page("__t.click(__t.byText('.project-card', 'E2E project'))")
      await c.waitFor('project page', "__t.text('.project-title-row h1') === 'E2E project'")
      c.answers.push([pdf, docx])
      await c.page("__t.click(__t.byText('.side-card-head .link-btn', 'Add files'))")
      await c.waitFor('files added', "__t.text('.knowledge-list').includes('report.pdf') && __t.text('.knowledge-list').includes('launch.docx')", 20000)
      c.answers.push(folder)
      await c.page("__t.click(__t.byText('.side-card-head .link-btn', 'Link folder'))")
      await c.waitFor('folder linked', "__t.text('.linked-folders').includes('field-notes')")
      await c.shot('project-knowledge')
      await c.page("__t.click(__t.q('.project-chat'))")
      await c.waitFor('project chat', "__t.text('.titlebar .crumb').includes('E2E project')")
      await c.send('search knowledge for giraffe', 'Knowledge: [1] report.pdf › [Page 2]')
      await c.send('search knowledge for zebra', 'Knowledge: [1] trip.md › Trip (folder field-notes')
      await c.send('search knowledge for okapi', 'Knowledge: [1] launch.docx (project files')
    }
  },
  {
    name: 'link an Obsidian vault and search its notes',
    run: async (c) => {
      const vault = c.file('Brain')
      c.mkdir(join(vault, '.obsidian'))
      c.mkdir(join(vault, 'Daily'))
      c.write(join(vault, 'Daily', '2026-10-01.md'), 'Bought a red bicycle today.')
      c.write(join(vault, 'Ideas.md'), 'A solar kettle, see [[Daily/2026-10-01]].')
      c.write(join(vault, '.obsidian', 'workspace.md'), 'bicycle settings that are not notes')
      c.write(c.file('obsidian.json'), JSON.stringify({ vaults: { abc: { path: vault, ts: Date.now(), open: true } } }))
      await c.openSettings('Obsidian')
      await c.waitFor('vault found', "__t.text('.vault-list').includes('Brain')")
      await c.page("__t.click(__t.byText('.vault-option', 'Brain'))")
      await c.waitFor('vault linked and read', "__t.text('.vault-status').includes('2 notes and documents searchable')", 20000)
      for (const label of ['Claude can write notes', 'Keep chats as notes', 'Keep memory as a note'])
        await c.page(`__t.click(__t.byText('.modal-body .toggle', ${JSON.stringify(label)}).querySelector('input'))`)
      await c.waitFor('options on', "__t.qa('.modal-body .toggle input').filter((i) => i.checked).length === 5")
      await c.shot('obsidian')
      await c.closeModal()
      await c.page("__t.click(__t.q('.side-new'))")
      await c.send('search knowledge for bicycle', 'Knowledge: [1] Daily/2026-10-01.md (Obsidian vault Brain')
    }
  },
  {
    name: 'Claude writes a note; chats and memory become notes in the vault',
    run: async (c) => {
      const vault = c.file('Brain')
      await c.send('save a note titled Kettle plans', 'Note: Saved LocalClaude/Notes/Kettle plans.md in the vault.')
      if (!c.read(join(vault, 'LocalClaude', 'Notes', 'Kettle plans.md')).toString().includes('Plans for Kettle plans. See [[Ideas]].')) throw new Error('the note is missing its text')
      const chats = join(vault, 'LocalClaude', 'Chats')
      const chatNote = () => c.list(chats).find((f) => f.endsWith('.md') && c.read(join(chats, f)).toString().includes('Kettle plans'))
      await c.until('the chat saved as a note', () => !!chatNote())
      if (!/^---\ntitle: /.test(c.read(join(chats, chatNote())).toString())) throw new Error('the chat note has no properties')
      await c.send('remember I like solar kettles', 'Noted.')
      const memory = join(vault, 'LocalClaude', 'Memory.md')
      await c.until('memory saved as a note', () => c.read(memory).toString().includes('- I like solar kettles'))
      await c.page("__t.click(__t.q('.title-menu .menu-trigger'))")
      await c.menuItem('Open in Obsidian')
      await c.until('opened in Obsidian', () => c.opened.some((u) => u.startsWith('obsidian://open?path=') && decodeURIComponent(u).endsWith('.md')))
    }
  },
  {
    name: 'switching Obsidian off stops using the vault, and back on again',
    run: async (c) => {
      const toggle = "__t.byText('.modal-body .toggle', 'Use your Obsidian vault').querySelector('input')"
      await c.openSettings('Obsidian')
      await c.page(`__t.click(${toggle})`)
      await c.waitFor('switched off', "__t.q('.obsidian-options').disabled && __t.text('.vault-status').includes('Switched off')")
      await c.shot('obsidian-off')
      await c.closeModal()
      const chats = join(c.file('Brain'), 'LocalClaude', 'Chats')
      const before = c.list(chats).length
      await c.page("__t.click(__t.q('.side-new'))")
      await c.send('search knowledge for bicycle', 'Knowledge: No knowledge server')
      await c.sleep(2500)
      if (c.list(chats).length !== before) throw new Error('a chat was saved to the vault while Obsidian was off')
      await c.page("__t.click(__t.q('.title-menu .menu-trigger'))")
      await c.waitFor('chat menu', "!!__t.q('.menu-item')")
      if (await c.page("!!__t.byText('.menu-item', 'Open in Obsidian')")) throw new Error('Open in Obsidian should be hidden while it is off')
      await c.page("__t.key(window, 'Escape')")
      await c.waitFor('menu closed', "!__t.q('.menu-item')")
      await c.openSettings('Obsidian')
      await c.page(`__t.click(${toggle})`)
      await c.waitFor('back on', "!__t.q('.obsidian-options').disabled && __t.text('.vault-status').includes('searchable')", 20000)
      await c.closeModal()
      await c.send('search knowledge for kettle', 'Knowledge: [1]')
      await c.until('saved to the vault again', () => c.list(chats).length > before)
    }
  },
  {
    name: 'Claude’s task list shows above the reply box while it works',
    run: async (c) => {
      await c.page("__t.setValue(__t.q('.composer-input'), 'plan tasks please'); __t.key(__t.q('.composer-input'), 'Enter')")
      await c.waitFor('task bar', "__t.text('.task-bar').includes('Writing tests') && __t.text('.task-bar').includes('1/3')")
      await c.page("__t.click(__t.q('.task-bar-head'))")
      await c.waitFor('every task', "__t.qa('.task-bar .todo').length === 3")
      await c.shot('task-bar')
      await c.waitFor('done', "__t.qa('.turn').some((t) => t.innerText.includes('Tasks planned.')) && !__t.q('.send.stop')", 15000)
      if (await c.page("!!__t.q('.task-bar')")) throw new Error('the task bar should go away when Claude is done')
    }
  },
  {
    name: 'git branch in the header, and a new chat in its own worktree',
    run: async (c) => {
      const repo = c.file('repo')
      c.mkdir(repo)
      c.git(repo, ['init', '-b', 'main'])
      c.git(repo, ['config', 'user.email', 'e2e@example.com'])
      c.git(repo, ['config', 'user.name', 'E2E'])
      c.write(join(repo, 'a.txt'), 'one')
      c.git(repo, ['add', '.'])
      c.git(repo, ['commit', '-m', 'first'])
      c.write(join(repo, 'b.txt'), 'not committed yet')
      await c.page("__t.click(__t.q('.side-new'))")
      await c.waitFor('new chat', "!__t.q('.msg-user') && !!__t.q('.composer-input')")
      c.answers.push(repo)
      await c.page("__t.click(__t.q('.title-menu .menu-trigger'))")
      await c.menuItem('Change')
      await c.waitFor('branch shown', "__t.text('.git-menu .menu-trigger').includes('main') && __t.text('.git-count') === '1'")
      await c.page("__t.click(__t.q('.git-menu .menu-trigger'))")
      await c.waitFor('changed file listed', "!!__t.byText('.menu-item', 'b.txt')")
      await c.page("__t.key(window, 'Escape')")
      await c.waitFor('menu closed', "!__t.q('.menu-item')")
      await c.page("__t.click(__t.q('.title-menu .menu-trigger'))")
      await c.menuItem('Work in a new git worktree')
      await c.waitFor('worktree dialog', "!!__t.q('.prompt-dialog input')")
      await c.page("__t.setValue(__t.q('.prompt-dialog input'), 'feature/e2e test')")
      await c.page("__t.click(__t.byText('.prompt-dialog .btn', 'Create worktree'))")
      await c.waitFor('on the new branch', "!__t.q('.prompt-dialog') && __t.text('.git-menu .menu-trigger').includes('feature/e2e-test')", 30000)
      if (!c.exists(join(c.file('repo-worktrees'), 'feature-e2e-test', 'a.txt'))) throw new Error('the worktree folder is missing')
      await c.send('hello worktree', 'Echo: hello worktree')
      await c.shot('git-worktree')
    }
  },
  {
    name: 'MCP servers: add one with the form, test it, switch it off',
    run: async (c) => {
      const script = c.file('weather-mcp.mjs')
      c.write(script, mcpServerScript())
      await c.openSettings('Tools')
      await c.page("__t.click(__t.byText('.mcp-manager .btn', 'Add a server'))")
      await c.waitFor('form', "!!__t.q('.mcp-form')")
      await c.page(`__t.setValue(__t.q('.mcp-form input[name="name"]'), 'weather')`)
      await c.page(`__t.setValue(__t.q('.mcp-form input[name="command"]'), 'node')`)
      await c.page(`__t.setValue(__t.q('.mcp-form textarea[name="args"]'), ${JSON.stringify(script)})`)
      await c.page("__t.click(__t.byText('.mcp-form .btn', 'Test'))")
      await c.waitFor('connected', "__t.text('.mcp-form .mcp-test').includes('Connected to e2e-weather · 2 tools')", 30000)
      await c.page("__t.click(__t.byText('.mcp-form .btn', 'Save'))")
      await c.waitFor('listed', "!!__t.byText('.mcp-server', 'weather') && !__t.q('.mcp-form')")
      await c.page(`__t.click(__t.byText('.mcp-server', 'weather').querySelector('button[title^="Test"]'))`)
      await c.waitFor('tested from the list', "__t.text('.mcp-list').includes('get_forecast, get_alerts')", 30000)
      await c.shot('mcp-manager')
      await c.page("__t.click(__t.byText('.mcp-server', 'weather').querySelector('.mcp-switch input'))")
      await c.waitFor('switched off', "__t.byText('.mcp-server', 'weather').classList.contains('off')")
      await c.page("__t.click(__t.byText('.mcp-manager .link-btn', 'Edit as JSON'))")
      await c.waitFor('JSON shows it off', "__t.q('.mcp-manager textarea.code').value.includes('\"enabled\": false')")
      await c.page("__t.click(__t.byText('.mcp-manager .link-btn', 'Back to the list'))")
      await c.page("__t.click(__t.byText('.mcp-manager .btn', 'Add a server'))")
      await c.page(`__t.setValue(__t.q('.mcp-form input[name="name"]'), 'memory')`)
      await c.page(`__t.setValue(__t.q('.mcp-form input[name="command"]'), 'node')`)
      await c.page("__t.click(__t.byText('.mcp-form .btn', 'Save'))")
      await c.waitFor('a name LocalClaude uses is refused', "__t.text('.mcp-form').includes('used by LocalClaude itself')")
      await c.page("__t.click(__t.byText('.mcp-form .btn', 'Cancel'))")
      await c.closeModal()
    }
  },
  {
    name: 'an artifact that errors: Fix with Claude, and open it in the browser',
    run: async (c) => {
      await c.page("__t.click(__t.q('.side-new'))")
      await c.send('make broken artifact', 'I made a page (it has a bug).')
      await c.waitFor('the error', "__t.text('.artifact-error').includes('boom from the page')", 15000)
      await c.shot('artifact-error')
      await c.page(`__t.click(__t.q('.artifact-head button[title="Open in your browser"]'))`)
      await c.until('opened in the browser', () => c.opened.some((u) => u.startsWith('file:') && decodeURIComponent(u).endsWith('Broken page.html')))
      await c.page("__t.click(__t.byText('.artifact-error .btn', 'Fix with Claude'))")
      await c.waitFor('asked Claude', "__t.qa('.msg-user').some((m) => m.innerText.includes('Broken page') && m.innerText.includes('boom from the page')) && !__t.q('.send.stop')", 15000)
      await c.waitFor('error bar gone', "!__t.q('.artifact-error')")
    }
  },
  {
    name: 'the Artifacts page lists every artifact',
    run: async (c) => {
      await c.page("__t.click(__t.byText('.side-nav', 'Artifacts'))")
      await c.waitFor('gallery', "__t.text('.page-head h1') === 'Artifacts' && __t.qa('.artifact-tile').length === 2")
      await c.page("__t.click(__t.byText('.kind-chip', 'Apps'))")
      await c.waitFor('no apps', "__t.qa('.artifact-tile').length === 0 && __t.text('.page-inner').includes('No artifacts match')")
      await c.page("__t.click(__t.byText('.kind-chip', 'Web pages'))")
      await c.page("__t.setValue(__t.q('.page-search input'), 'demo')")
      await c.waitFor('one match', "__t.qa('.artifact-tile').length === 1 && __t.text('.artifact-tile').includes('Demo page')")
      await c.shot('artifacts-page')
      await c.page("__t.click(__t.q('.artifact-tile'))")
      await c.waitFor('opened in its chat', "__t.text('.artifact-panel .artifact-title') === 'Demo page'")
    }
  },
  {
    name: 'select several chats: pin, move to a project, export, delete',
    run: async (c) => {
      for (const t of ['throwaway one', 'throwaway two']) {
        await c.page("__t.click(__t.q('.side-new'))")
        await c.send(t, 'Echo: ' + t)
      }
      await c.waitFor('titled', "__t.qa('.session-title').filter((e) => e.textContent.startsWith('Chat about throwaway')).length === 2")
      const ctrlClick = (t) => `(() => { __t.qa('.session-item').find((e) => e.textContent.includes(${JSON.stringify(t)})).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); return true })()`
      await c.page(ctrlClick('Chat about throwaway one'))
      await c.page(ctrlClick('Chat about throwaway two'))
      await c.waitFor('two selected', "__t.text('.bulk-count') === '2 selected' && __t.qa('.session-item.selected').length === 2")
      await c.shot('bulk-select')
      await c.page(`__t.click(__t.q('.bulk-bar button[title="Pin"]'))`)
      await c.waitFor('pinned', "__t.qa('.side-section').some((s) => s.textContent.includes('Pinned') && s.textContent.includes('throwaway one') && s.textContent.includes('throwaway two'))")
      await c.page("__t.click(__t.q('.bulk-move .menu-trigger'))")
      await c.menuItem('E2E project')
      await c.waitFor('moved', "__t.text('.toast').includes('Moved 2 chats to “E2E project”')")
      const zip = c.file('two-chats.zip')
      c.answers.push(zip)
      await c.page(`__t.click(__t.q('.bulk-bar button[title="Export…"]'))`)
      await c.waitFor('export dialog', "__t.text('.export-dialog').includes('Selected chats')")
      await c.page("__t.click(__t.byText('.export-dialog .btn', 'Export ZIP'))")
      await c.waitFor('exported', "__t.text('.export-dialog').includes('Exported')")
      if (c.read(zip).subarray(0, 2).toString() !== 'PK') throw new Error('not a ZIP file')
      await c.page("__t.click(__t.byText('.export-dialog .btn', 'Done'))")
      await c.page('window.confirm = () => true; true')
      await c.page("__t.click(__t.q('.bulk-delete'))")
      await c.waitFor('deleted', "!__t.qa('.session-title').some((e) => e.textContent.includes('throwaway')) && !__t.q('.bulk-bar')")
    }
  },
  {
    name: 'drag a chat onto a project',
    run: async (c) => {
      await c.page("__t.click(__t.q('.side-new'))")
      await c.send('drag me please', 'Echo: drag me please')
      await c.waitFor('titled', "__t.qa('.session-title').some((e) => e.textContent.includes('Chat about drag me'))")
      await c.page("__t.click(__t.byText('.side-nav', 'Projects'))")
      await c.waitFor('project cards', "!!__t.byText('.project-card', 'E2E project')")
      await c.page(`(() => {
        const item = __t.qa('.session-item').find((e) => e.textContent.includes('Chat about drag me'))
        const card = __t.byText('.project-card', 'E2E project')
        const dt = new DataTransfer()
        item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
        card.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
        card.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
        return true
      })()`)
      await c.waitFor('moved', "__t.text('.toast').includes('Moved 1 chat to “E2E project”')")
      await c.waitFor('the project has it', "__t.byText('.project-card', 'E2E project').textContent.includes('2 chats')")
    }
  },
  {
    name: 'project folders: from the project page and from a chat, and new projects from a folder',
    run: async (c) => {
      const [main, docs, assets, lab] = ['doraemon-app', 'doraemon-docs', 'doraemon-assets', 'gadget-lab'].map((n) => c.file(n))
      for (const d of [main, docs, assets, lab]) c.mkdir(d)
      await c.page("__t.click(__t.byText('.project-card', 'E2E project'))")
      await c.waitFor('project page', "__t.text('.project-title-row h1') === 'E2E project'")
      c.answers.push(main)
      await c.page("__t.click(__t.byText('.folders-card .link-btn', 'Add folder'))")
      await c.waitFor('the main folder', "__t.text('.project-dirs').includes('doraemon-app') && __t.text('.project-dirs').includes('main')")
      c.answers.push(docs)
      await c.page("__t.click(__t.byText('.folders-card .link-btn', 'Add folder'))")
      await c.waitFor('a second folder', "__t.qa('.project-dirs li').length === 2")
      await c.shot('project-folders')
      await c.page("__t.click(__t.q('.project-chat'))")
      await c.waitFor('a chat in the project', "__t.text('.titlebar .crumb').includes('E2E project')")
      await c.page("__t.click(__t.q('.title-menu .menu-trigger'))")
      await c.waitFor('the project’s folders in its menu', "!!__t.byText('.menu-item', 'doraemon-app') && __t.byText('.menu-item', 'doraemon-docs').textContent.includes('From the project')")
      if (await c.page("__t.qa('.menu-pop > *').some((e) => getComputedStyle(e).flexShrink !== '0')")) throw new Error('menu rows can still be squeezed')
      await c.shot('chat-folder-menu')
      c.answers.push(assets)
      await c.menuItem('Add a folder to “E2E project”')
      await c.page("__t.click(__t.q('.title-menu .menu-trigger'))")
      await c.waitFor('added for the whole project', "!!__t.byText('.menu-item', 'doraemon-assets')")
      await c.page("__t.key(window, 'Escape')")
      await c.waitFor('menu closed', "!__t.q('.menu-item')")
      await c.page("__t.click(__t.byText('.side-nav', 'Projects'))")
      await c.page("__t.click(__t.byText('.page-head .btn', 'New project'))")
      c.answers.push(lab)
      await c.page("__t.click(__t.byText('.project-form .btn', 'Choose'))")
      await c.waitFor('named after the folder', "__t.q('.project-form input').value === 'gadget-lab'")
      await c.page("__t.click(__t.byText('.project-form .btn', 'Create project'))")
      await c.waitFor('created with its folder', "__t.text('.project-title-row h1') === 'gadget-lab' && __t.text('.project-dirs').includes('gadget-lab')")
    }
  }
]
