// Starts the end-to-end tests: the real app (built into out/) under Electron, with a scripted Claude.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const electron = require('electron') // the binary's path when required from Node
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE // VS Code sets this; it would make Electron run as plain Node
// CI's Linux machines don't set up Chromium's sandbox helper
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const child = spawn(electron, [...flags, resolve('test/e2e/run.mjs'), ...process.argv.slice(2)], { stdio: 'inherit', env })
const timer = setTimeout(() => {
  console.error('✗ end-to-end tests timed out')
  child.kill()
  process.exit(1)
}, 10 * 60 * 1000)
child.on('exit', (code) => {
  clearTimeout(timer)
  process.exit(code ?? 1)
})
