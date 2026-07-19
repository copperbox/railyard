import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Deterministic content hash of an agent folder (SPEC §11): sha256 over the
 * sorted (relative path, file bytes) pairs. Unchanged folders are image cache
 * hits; any edit changes the hash and rebuilds on next boot.
 */
export async function hashAgentFolder(dir: string): Promise<string> {
  const files = (await walk(dir, '')).sort()
  const hash = createHash('sha256')
  for (const rel of files) {
    hash.update(rel)
    hash.update('\0')
    hash.update(await readFile(path.join(dir, rel)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** Local image tag for a Dockerfile-built agent. */
export function imageTagFor(agentName: string, folderHash: string): string {
  return `railyard/${agentName}:${folderHash.slice(0, 12)}`
}

async function walk(root: string, rel: string): Promise<string[]> {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    // Posix separators so the hash is stable across platforms.
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...(await walk(root, childRel)))
    } else if (entry.isFile()) {
      files.push(childRel)
    }
  }
  return files
}
