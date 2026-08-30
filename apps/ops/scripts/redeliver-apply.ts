import PgBoss from 'pg-boss'
import { loadConfig } from '../src/config.ts'
import { loadDotEnv } from '../src/load-env.ts'

/**
 * Tier-2 helper (6B walk #2): re-enqueues `proposal.apply` for an already-decided proposal so the
 * DEPLOYED worker gets a SECOND delivery of the same apply — the never-refund-twice check. Sends
 * with the same singletonKey the real approval path uses, so pg-boss's singleton policy applies
 * exactly as it would in production (a still-active first delivery is deduplicated, not doubled).
 *
 *   DATABASE_URL='<railway>' pnpm --filter @doge-buddy/ops redeliver-apply <proposalId>
 */
loadDotEnv(import.meta.url)
const config = loadConfig(process.env)
const proposalId = process.argv[2]
if (!proposalId) {
  console.error('usage: redeliver-apply <proposalId>')
  process.exit(2)
}
const boss = new PgBoss(config.databaseUrl)
boss.on('error', (e) => console.error('[pg-boss]', e))
await boss.start()
try {
  const jobId = await boss.send('proposal.apply', { proposalId }, { singletonKey: proposalId, retryLimit: 0 })
  console.log(jobId ? `redeliver-apply: enqueued job ${jobId} for proposal ${proposalId}` : `redeliver-apply: NOT enqueued — a job with singletonKey ${proposalId} is still created/active`)
} finally {
  await boss.stop()
}
