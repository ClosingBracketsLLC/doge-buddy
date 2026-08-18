import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Several test files start a real pg-boss instance (`startQueue`) against the shared test
    // database (queue.test.ts, webhook-router.test.ts's real-registration describe block,
    // queue-fulfillment.test.ts, and more to come in later Phase 3 tasks). pg-boss's job fetch
    // is a DB-level `FOR UPDATE SKIP LOCKED` race across *any* connected client, not scoped to
    // the process that enqueued the job — so with files running in parallel workers, a job sent
    // from one file's boss instance can be picked up by a different file's worker instead of its
    // own, silently bypassing in-process spies/mocks. Serializing file execution removes that
    // cross-file race; the suite is small enough that this costs a few seconds, not minutes.
    fileParallelism: false,
  },
})
