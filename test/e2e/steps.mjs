// End-to-end steps, run in order against one app instance (see run.mjs). Each step drives the real UI.
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
  }
]
