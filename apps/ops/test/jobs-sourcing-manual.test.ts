import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/sourcing/pipeline.ts', () => ({
  runSourcingPipeline: vi.fn(async () => ({ runId: 'r1', outcome: 'completed', submitted: 2 })),
}))

import { runSourcingPipeline } from '../src/sourcing/pipeline.ts'
import { sourcingManualHandler } from '../src/jobs/sourcing-manual.ts'

const baseDeps = () =>
  ({
    alert: vi.fn(async () => {}),
    // The handler spreads deps straight into runSourcingPipeline (mocked), so the rest can be inert.
  }) as never

describe('sourcing.manual worker', () => {
  it('runs the pipeline with force: true and the job overrides', async () => {
    const deps = baseDeps()
    const overrides = { maxWinners: 8, keywords: ['dog toy'] }
    await sourcingManualHandler(deps)([{ id: 'j1', name: 'sourcing.manual', data: { overrides } }] as never)
    expect(runSourcingPipeline).toHaveBeenCalledWith(expect.objectContaining({ force: true, overrides }))
  })

  it('missing data -> still forced, overrides undefined', async () => {
    await sourcingManualHandler(baseDeps())([{ id: 'j2', name: 'sourcing.manual', data: undefined }] as never)
    expect(runSourcingPipeline).toHaveBeenLastCalledWith(expect.objectContaining({ force: true, overrides: undefined }))
  })

  it('a pipeline throw alerts critical sourcing_run_failed with trigger manual, never rethrows', async () => {
    vi.mocked(runSourcingPipeline).mockRejectedValueOnce(new Error('knob out of range'))
    const alert = vi.fn(async () => {})
    const deps = { alert } as never
    await expect(
      sourcingManualHandler(deps)([{ id: 'j3', name: 'sourcing.manual', data: {} }] as never),
    ).resolves.toBeUndefined()
    expect(alert).toHaveBeenCalledWith('critical', 'sourcing_run_failed', { error: 'knob out of range', trigger: 'manual' })
  })
})
