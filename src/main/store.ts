// Encrypted, machine-bound local storage.
//
// Two layers protect everything this app saves (settings, MCP config, chat history):
//   1. AES-256-GCM with a key derived (scrypt) from this machine's OS machine id.
//      Copy the data folder to another PC and it cannot be decrypted there.
//   2. Electron safeStorage on top (Windows DPAPI / Linux libsecret keyring),
//      which also ties the data to your OS user account.
import { app, safeStorage } from 'electron'
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readMachineId } from './machineId'
import { AppSettings, ChatMessage, DEFAULT_SETTINGS, LockStatus, SessionMeta } from '../shared/types'

interface Vault {
  version: 1
  machineHash: string
  settings: AppSettings
  sessions: SessionMeta[]
}

const MAGIC = Buffer.from('LCV1')

export class SecureStore {
  private dir = join(app.getPath('userData'), 'vault')
  private vaultFile = join(this.dir, 'vault.bin')
  private saltFile = join(this.dir, 'salt.bin')
  private sessionsDir = join(this.dir, 'sessions')
  private key!: Buffer
  private machineHash!: string
  private vault!: Vault
  lock: LockStatus = { ok: false, encryptionBackend: 'unknown', machineIdShort: '' }

  open(): LockStatus {
    mkdirSync(this.sessionsDir, { recursive: true })
    let rawId: string
    try {
      rawId = readMachineId()
    } catch (e) {
      this.lock = { ok: false, reason: `Could not read machine id: ${String(e)}`, encryptionBackend: 'none', machineIdShort: '' }
      return this.lock
    }
    this.machineHash = createHash('sha256').update('localclaude:' + rawId).digest('hex')

    let salt: Buffer
    if (existsSync(this.saltFile)) salt = readFileSync(this.saltFile)
    else {
      salt = randomBytes(32)
      writeFileSync(this.saltFile, salt)
    }
    this.key = scryptSync(rawId, salt, 32)

    const backend =
      process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function'
        ? safeStorage.getSelectedStorageBackend()
        : safeStorage.isEncryptionAvailable()
          ? process.platform === 'win32'
            ? 'dpapi'
            : 'os'
          : 'none'

    this.lock = { ok: true, encryptionBackend: backend, machineIdShort: this.machineHash.slice(0, 12) }

    if (!existsSync(this.vaultFile)) {
      this.vault = { version: 1, machineHash: this.machineHash, settings: { ...DEFAULT_SETTINGS, defaultCwd: app.getPath('home') }, sessions: [] }
      this.saveVault()
      return this.lock
    }

    try {
      const v = JSON.parse(this.decrypt(readFileSync(this.vaultFile))) as Vault
      if (v.machineHash !== this.machineHash) throw new Error('machine mismatch')
      v.settings = { ...DEFAULT_SETTINGS, ...v.settings }
      this.vault = v
    } catch {
      this.lock = {
        ...this.lock,
        ok: false,
        reason:
          'This app data was created on a different machine or OS user account, so it cannot be opened here. You can reset to start fresh on this machine (the old data stays unreadable).'
      }
    }
    return this.lock
  }

  /** Wipe all app data and start fresh, bound to this machine. */
  reset(): LockStatus {
    rmSync(this.dir, { recursive: true, force: true })
    return this.open()
  }

  // ---------- crypto ----------
  private encrypt(plain: string): Buffer {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', this.key, iv)
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()])
    let out = Buffer.concat([MAGIC, iv, c.getAuthTag(), body])
    if (safeStorage.isEncryptionAvailable()) {
      out = Buffer.concat([Buffer.from('S'), safeStorage.encryptString(out.toString('base64'))])
    } else {
      out = Buffer.concat([Buffer.from('P'), out])
    }
    return out
  }

  private decrypt(buf: Buffer): string {
    let inner: Buffer
    const tag = buf.subarray(0, 1).toString()
    if (tag === 'S') inner = Buffer.from(safeStorage.decryptString(buf.subarray(1)), 'base64')
    else if (tag === 'P') inner = buf.subarray(1)
    else throw new Error('bad vault')
    if (!inner.subarray(0, 4).equals(MAGIC)) throw new Error('bad magic')
    const iv = inner.subarray(4, 16)
    const authTag = inner.subarray(16, 32)
    const d = createDecipheriv('aes-256-gcm', this.key, iv)
    d.setAuthTag(authTag)
    return Buffer.concat([d.update(inner.subarray(32)), d.final()]).toString('utf8')
  }

  private atomicWrite(file: string, data: Buffer): void {
    const tmp = file + '.tmp'
    writeFileSync(tmp, data)
    renameSync(tmp, file)
  }

  private saveVault(): void {
    this.atomicWrite(this.vaultFile, this.encrypt(JSON.stringify(this.vault)))
  }

  // ---------- settings ----------
  getSettings(): AppSettings {
    return this.vault.settings
  }
  setSettings(s: Partial<AppSettings>): AppSettings {
    this.vault.settings = { ...this.vault.settings, ...s }
    this.saveVault()
    return this.vault.settings
  }

  // ---------- sessions ----------
  listSessions(): SessionMeta[] {
    return [...this.vault.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  }
  getSession(id: string): SessionMeta | undefined {
    return this.vault.sessions.find((s) => s.id === id)
  }
  upsertSession(meta: SessionMeta): void {
    const i = this.vault.sessions.findIndex((s) => s.id === meta.id)
    if (i >= 0) this.vault.sessions[i] = meta
    else this.vault.sessions.push(meta)
    this.saveVault()
  }
  deleteSession(id: string): void {
    this.vault.sessions = this.vault.sessions.filter((s) => s.id !== id)
    this.saveVault()
    rmSync(this.historyFile(id), { force: true })
  }

  private historyFile(id: string): string {
    return join(this.sessionsDir, id.replace(/[^a-zA-Z0-9-]/g, '') + '.bin')
  }
  loadHistory(id: string): ChatMessage[] {
    const f = this.historyFile(id)
    if (!existsSync(f)) return []
    try {
      return JSON.parse(this.decrypt(readFileSync(f))) as ChatMessage[]
    } catch {
      return []
    }
  }
  saveHistory(id: string, messages: ChatMessage[]): void {
    this.atomicWrite(this.historyFile(id), this.encrypt(JSON.stringify(messages)))
  }

  countHistoryFiles(): number {
    return readdirSync(this.sessionsDir).length
  }
}
