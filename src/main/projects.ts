// Projects: groups of chats with shared instructions, knowledge files and a working folder.
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { Project } from '../shared/types'
import type { SecureStore } from './store'

const MAX_FILE_BYTES = 5 * 1024 * 1024

export function createProject(store: SecureStore, input: { name: string; description?: string }): Project {
  const now = Date.now()
  const p: Project = {
    id: randomUUID(),
    name: input.name.trim() || 'Untitled project',
    description: input.description?.trim() ?? '',
    instructions: '',
    files: [],
    createdAt: now,
    updatedAt: now
  }
  store.upsertProject(p)
  return p
}

export function updateProject(store: SecureStore, id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'instructions' | 'cwd' | 'pinned'>>): Project {
  const p = store.getProject(id)
  if (!p) throw new Error('Unknown project')
  // Pinning doesn't count as an edit, so it doesn't change "updated … ago" or the sort order.
  const pinOnly = Object.keys(patch).every((k) => k === 'pinned')
  const next = { ...p, ...patch, updatedAt: pinOnly ? p.updatedAt : Date.now() }
  store.upsertProject(next)
  return next
}

/** Text that looks binary (NUL bytes) can't be used as knowledge. */
function readText(path: string): string | null {
  const buf = readFileSync(path)
  if (buf.subarray(0, 8192).includes(0)) return null
  return buf.toString('utf8')
}

/** Copy text files into the project's encrypted knowledge. Returns the project and any files that were skipped. */
export function addProjectFiles(store: SecureStore, id: string, paths: string[]): { project: Project; skipped: string[] } {
  const p = store.getProject(id)
  if (!p) throw new Error('Unknown project')
  const contents = store.loadProjectFiles(id)
  const files = [...p.files]
  const skipped: string[] = []
  for (const path of paths) {
    const name = basename(path)
    try {
      const size = statSync(path).size
      if (size > MAX_FILE_BYTES) {
        skipped.push(`${name} (over 5 MB)`)
        continue
      }
      const text = readText(path)
      if (text === null) {
        skipped.push(`${name} (not a text file)`)
        continue
      }
      // Re-adding a file with the same name replaces it.
      const existing = files.find((f) => f.name === name)
      const fid = existing?.id ?? randomUUID()
      contents[fid] = text
      if (existing) Object.assign(existing, { size, addedAt: Date.now() })
      else files.push({ id: fid, name, size, addedAt: Date.now() })
    } catch (e) {
      skipped.push(`${name} (${e instanceof Error ? e.message : String(e)})`)
    }
  }
  store.saveProjectFiles(id, contents)
  const next = { ...p, files, updatedAt: Date.now() }
  store.upsertProject(next)
  return { project: next, skipped }
}

export function removeProjectFile(store: SecureStore, id: string, fileId: string): Project {
  const p = store.getProject(id)
  if (!p) throw new Error('Unknown project')
  const contents = store.loadProjectFiles(id)
  delete contents[fileId]
  store.saveProjectFiles(id, contents)
  const next = { ...p, files: p.files.filter((f) => f.id !== fileId), updatedAt: Date.now() }
  store.upsertProject(next)
  return next
}
