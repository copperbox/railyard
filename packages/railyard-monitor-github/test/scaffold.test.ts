import { describe, expect, it } from 'vitest'

describe('package scaffold', () => {
  it('imports the package entry and the core peer dependency', async () => {
    await expect(import('../src/index.js')).resolves.toBeDefined()
    const core = await import('@copperbox/railyard')
    expect(core.Orchestrator).toBeDefined()
  })
})
