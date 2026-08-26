import type PgBoss from 'pg-boss'
import { describe, expect, it, vi } from 'vitest'
import { registerCron } from '../src/queue.ts'

// `registerCron` only ever calls these four `PgBoss` methods, so a minimal stub covering just
// them (rather than a real `PgBoss` instance / real Postgres) is enough to assert on call shape.
// `getQueue`'s return is configured per-test since its value drives the policy-preservation logic
// under test.
function fakeBoss(getQueueResult: Partial<PgBoss.Queue> | null = null): PgBoss {
  return {
    createQueue: vi.fn().mockResolvedValue(undefined),
    updateQueue: vi.fn().mockResolvedValue(undefined),
    getQueue: vi.fn().mockResolvedValue(getQueueResult),
    work: vi.fn().mockResolvedValue('worker-id'),
    schedule: vi.fn().mockResolvedValue(undefined),
  } as unknown as PgBoss
}

describe('registerCron: policy + singletonKey (Task 7)', () => {
  it('opts.policy set to singleton: createQueue gets the policy, updateQueue applies it', async () => {
    const boss = fakeBoss({ policy: 'singleton' })

    await registerCron(boss, 'test.policy-explicit', '0 13 * * 1', async () => {}, { policy: 'singleton' })

    expect(boss.createQueue).toHaveBeenCalledWith('test.policy-explicit', {
      name: 'test.policy-explicit',
      policy: 'singleton',
    })
    expect(boss.updateQueue).toHaveBeenCalledWith('test.policy-explicit', {
      name: 'test.policy-explicit',
      policy: 'singleton',
    })
  })

  it('opts without policy on a pre-existing singleton queue: updateQueue preserves singleton', async () => {
    const boss = fakeBoss({ policy: 'singleton' })

    await registerCron(boss, 'test.policy-preserve', '0 13 * * 1', async () => {}, { retryLimit: 0 })

    expect(boss.updateQueue).toHaveBeenCalledWith('test.policy-preserve', {
      name: 'test.policy-preserve',
      policy: 'singleton',
      retryLimit: 0,
    })
  })

  it('opts.singletonKey set: schedule is called with the 4-arg singletonKey form', async () => {
    const boss = fakeBoss()

    await registerCron(boss, 'test.singleton-key', '* * * * *', async () => {}, { singletonKey: 'k' })

    expect(boss.schedule).toHaveBeenCalledWith('test.singleton-key', '* * * * *', {}, { singletonKey: 'k' })
  })

  it('no opts: schedule is called two-arg, and updateQueue is never called', async () => {
    const boss = fakeBoss()

    await registerCron(boss, 'test.no-opts', '0 13 * * 1', async () => {})

    expect(boss.schedule).toHaveBeenCalledWith('test.no-opts', '0 13 * * 1')
    expect(boss.updateQueue).not.toHaveBeenCalled()
    expect(boss.createQueue).toHaveBeenCalledWith('test.no-opts', undefined)
  })
})
