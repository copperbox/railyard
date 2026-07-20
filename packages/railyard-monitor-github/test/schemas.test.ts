import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compilePayloadSchema } from '@copperbox/railyard'
import { describe, expect, it } from 'vitest'
import {
  GITHUB_ISSUE_CLOSED_SCHEMA,
  GITHUB_ISSUE_LABELED_SCHEMA,
  GITHUB_ISSUE_REOPENED_SCHEMA,
  GITHUB_ISSUE_SIGNAL_TYPES,
  GITHUB_ISSUE_UNLABELED_SCHEMA,
  githubIssueEmits,
  type GitHubIssueLabeledPayload,
} from '../src/index.js'

const schemasDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../schemas')

const FILES = {
  [GITHUB_ISSUE_SIGNAL_TYPES.labeled]: 'github-issue-labeled.schema.json',
  [GITHUB_ISSUE_SIGNAL_TYPES.unlabeled]: 'github-issue-unlabeled.schema.json',
  [GITHUB_ISSUE_SIGNAL_TYPES.closed]: 'github-issue-closed.schema.json',
  [GITHUB_ISSUE_SIGNAL_TYPES.reopened]: 'github-issue-reopened.schema.json',
} as const

async function readSchema(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(schemasDir, file), 'utf8')) as Record<string, unknown>
}

export function validLabeledPayload(): GitHubIssueLabeledPayload {
  return {
    repo: {
      owner: 'copperbox',
      name: 'railyard',
      fullName: 'copperbox/railyard',
      url: 'https://github.com/copperbox/railyard',
      private: false,
    },
    issue: {
      number: 42,
      title: 'Something is broken',
      body: 'Details…',
      state: 'open',
      author: 'dan-essig',
      labels: ['bug', 'needs-review'],
      assignees: [],
      url: 'https://github.com/copperbox/railyard/issues/42',
      apiUrl: 'https://api.github.com/repos/copperbox/railyard/issues/42',
      createdAt: '2026-07-19T10:00:00Z',
      updatedAt: '2026-07-19T12:00:00Z',
    },
    label: { name: 'needs-review', color: 'd73a4a' },
    actor: 'dan-essig',
    eventId: 31415926535,
    occurredAt: '2026-07-19T12:34:56Z',
  }
}

describe('published github.issue.* schemas', () => {
  it('declares all four types, and only those', () => {
    expect(githubIssueEmits.map((d) => d.type).sort()).toEqual(
      Object.values(GITHUB_ISSUE_SIGNAL_TYPES).sort(),
    )
    expect(githubIssueEmits).toHaveLength(4)
  })

  it.each(Object.entries(FILES))('%s: shipped file compiles and matches the export', async (type, file) => {
    const onDisk = await readSchema(file)
    expect(() => compilePayloadSchema(onDisk, `file ${file}`)).not.toThrow()
    const declared = githubIssueEmits.find((d) => d.type === type)
    expect(declared, `no emits declaration for ${type}`).toBeDefined()
    // The exported constant (inlined at build) must deep-equal the shipped file.
    expect(declared?.payloadSchema).toEqual(onDisk)
  })

  it('accepts a valid labeled payload', () => {
    const validate = compilePayloadSchema(GITHUB_ISSUE_LABELED_SCHEMA, 'labeled')
    expect(validate(validLabeledPayload())).toBe(true)
  })

  it('accepts nullable body, color, actor, author', () => {
    const validate = compilePayloadSchema(GITHUB_ISSUE_LABELED_SCHEMA, 'labeled')
    const payload = validLabeledPayload()
    payload.issue.body = null
    payload.issue.author = null
    payload.label.color = null
    payload.actor = null
    expect(validate(payload)).toBe(true)
  })

  it('rejects a payload missing a required field', () => {
    const validate = compilePayloadSchema(GITHUB_ISSUE_LABELED_SCHEMA, 'labeled')
    const payload = validLabeledPayload() as Partial<GitHubIssueLabeledPayload>
    delete payload.label
    expect(validate(payload)).toBe(false)
  })

  it('rejects extra fields at every level (additionalProperties: false)', () => {
    const validate = compilePayloadSchema(GITHUB_ISSUE_LABELED_SCHEMA, 'labeled')
    expect(validate({ ...validLabeledPayload(), extra: 1 })).toBe(false)
    const nested = validLabeledPayload()
    ;(nested.issue as unknown as Record<string, unknown>).milestone = 'v1'
    expect(validate(nested)).toBe(false)
  })

  it('rejects wrong types', () => {
    const validate = compilePayloadSchema(GITHUB_ISSUE_LABELED_SCHEMA, 'labeled')
    const payload = validLabeledPayload()
    ;(payload as unknown as Record<string, unknown>).eventId = 'not-a-number'
    expect(validate(payload)).toBe(false)
  })

  it('closed schema rejects a label property; labeled requires it', () => {
    const validateClosed = compilePayloadSchema(GITHUB_ISSUE_CLOSED_SCHEMA, 'closed')
    const { label: _label, ...shapeB } = validLabeledPayload()
    expect(validateClosed(shapeB)).toBe(true)
    expect(validateClosed(validLabeledPayload())).toBe(false)
  })

  it('labeled/unlabeled and closed/reopened differ only in $id, title, description', async () => {
    const strip = (schema: Record<string, unknown>) => {
      const { $id: _i, title: _t, description: _d, ...rest } = schema
      return rest
    }
    const [labeled, unlabeled, closed, reopened] = await Promise.all(
      Object.values(FILES).map(readSchema),
    )
    // Shape A pair — the label descriptions differ ("applied" vs "removed"), so
    // compare with the label description stripped too.
    const stripLabelDesc = (schema: Record<string, unknown>) => {
      const clone = JSON.parse(JSON.stringify(strip(schema))) as {
        properties: { label: { description?: string } }
      }
      delete clone.properties.label.description
      return clone
    }
    expect(stripLabelDesc(labeled!)).toEqual(stripLabelDesc(unlabeled!))
    expect(strip(closed!)).toEqual(strip(reopened!))
  })

  it('a mutated copy is no longer compatible-by-equality with the declared schema', async () => {
    const onDisk = await readSchema(FILES['github.issue.labeled'])
    const mutated = JSON.parse(JSON.stringify(onDisk)) as {
      properties: Record<string, unknown>
    }
    mutated.properties.renamed = mutated.properties.label!
    delete mutated.properties.label
    expect(mutated).not.toEqual(GITHUB_ISSUE_LABELED_SCHEMA)
  })
})
