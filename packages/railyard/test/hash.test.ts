import { mkdtemp, mkdir, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashAgentFolder, imageTagFor } from '../src/docker/hash.js'

async function makeFolder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'railyard-hash-'))
  for (const [rel, content] of Object.entries(files)) {
    const filePath = path.join(dir, rel)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, content)
  }
  return dir
}

const FILES = {
  'manifest.yaml': 'name: echo\n',
  Dockerfile: 'FROM alpine\n',
  'schemas/tick.json': '{}',
}

describe('agent folder content hash', () => {
  it('is stable across separate folders with identical content', async () => {
    // Written in different orders; hash must not depend on directory iteration.
    const a = await makeFolder(FILES)
    const b = await makeFolder({
      'schemas/tick.json': '{}',
      Dockerfile: 'FROM alpine\n',
      'manifest.yaml': 'name: echo\n',
    })
    expect(await hashAgentFolder(a)).toBe(await hashAgentFolder(b))
  })

  it('changes when file content changes', async () => {
    const dir = await makeFolder(FILES)
    const before = await hashAgentFolder(dir)
    await writeFile(path.join(dir, 'Dockerfile'), 'FROM alpine:3.20\n')
    expect(await hashAgentFolder(dir)).not.toBe(before)
  })

  it('changes when a file is renamed', async () => {
    const dir = await makeFolder(FILES)
    const before = await hashAgentFolder(dir)
    await rename(path.join(dir, 'Dockerfile'), path.join(dir, 'Dockerfile.bak'))
    expect(await hashAgentFolder(dir)).not.toBe(before)
  })

  it('distinguishes path-boundary ambiguity (a/b vs ab)', async () => {
    const a = await makeFolder({ 'a/b': 'x' })
    const b = await makeFolder({ ab: 'x' })
    expect(await hashAgentFolder(a)).not.toBe(await hashAgentFolder(b))
  })

  it('produces a docker-legal tag', async () => {
    const dir = await makeFolder(FILES)
    const tag = imageTagFor('github-reviewer', await hashAgentFolder(dir))
    expect(tag).toMatch(/^railyard\/github-reviewer:[0-9a-f]{12}$/)
  })
})
