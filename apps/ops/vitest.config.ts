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
    // own, silently bypassing in-process spies/mocks. Reproduced this deterministically (3/3
    // runs) by temporarily flipping this flag back to true.
    //
    // Considered per-file pg-boss `schema` isolation (the constructor takes `{ connectionString,
    // schema }`) as the narrower fix — it would let the ~12 non-pg-boss files stay parallel and
    // let the pg-boss files run in parallel with *each other* too. Rejected it after actually
    // weighing the cost, not just in theory:
    //   - It requires threading a new, test-only `schema` option through `startQueue`'s
    //     production signature (or reimplementing its wiring in test code, which would stop
    //     testing the real function).
    //   - It's opt-in per file. `fileParallelism: false` protects every current *and future*
    //     pg-boss test file with one line; schema isolation only protects a file whose author
    //     remembers to pass a unique schema — forgetting it reintroduces this exact race with no
    //     error, just intermittent flakiness. Given five more fulfillment integration test files
    //     are still coming (Tasks 11, 13, 14, 15, 17), that's a real, recurring risk, not a
    //     one-time cost.
    //   - A brand-new schema needs pg-boss's full first-time migration (its own set of tables/
    //     functions/indices) run against it, which reintroduces a smaller version of the exact
    //     concurrent-first-time-DDL hazard `createQueueRetrying` in queue.ts was added to fix —
    //     just moved one level up and multiplied by N schemas instead of solved.
    //   - Measured the actual cost of NOT doing it: with this flag true vs false, three
    //     back-to-back full-suite runs of each showed statistically the same wall-clock time
    //     (~15s either way) — the suite's runtime is dominated by the pg-boss-heavy files' own
    //     real timing waits (queue-fulfillment.test.ts's dedupe test alone takes several seconds
    //     regardless of what else runs alongside it), not by file-level parallelism. There is no
    //     real speed win being given up here today.
    //
    // Same reasoning extends outside this file's control: a stray `tsx src/index.ts` dev server
    // left running against this same test DB registers its own real pg-boss workers on these
    // queues and will race/steal jobs this suite sends. Kill any such process before running.
    fileParallelism: false,
  },
})
