import type PgBoss from 'pg-boss'
import { type ApplyProposalDeps, deadLetterApplyProposal, executeApplyProposal } from '../proposals/run-apply.ts'

/**
 * Only the fields this handler actually reads off a pg-boss job — a strict structural subset of
 * `PgBoss.JobWithMetadata<T>`. Same shape as `jobs/fulfillment-pay-order.ts`'s `PayOrderJob` —
 * see that file's own doc comment for why this beats depending on the full metadata surface.
 */
type ProposalApplyJob = Pick<
  PgBoss.JobWithMetadata<{ proposalId: string }>,
  'id' | 'name' | 'data' | 'retryCount' | 'retryLimit'
>

/**
 * Worker callback for the `proposal.apply` queue. Thin adapter over the real executor
 * (`run-apply.ts`) with one piece of job-lifecycle logic that can't live in the executor itself:
 * retry-exhaustion dead-lettering.
 *
 * Structural clone of `fulfillmentPayOrderHandler` (`jobs/fulfillment-pay-order.ts`) — same
 * `retryCount >= retryLimit` dead-letter check on the attempt that just threw, same nested
 * try/catch around the dead-letter transition itself (routed through `alert`, never
 * `console.error`, since `alert()` both pino-logs AND writes `audit_log`), same "the ORIGINAL
 * error must still propagate regardless" contract. See that file's doc comment for the full
 * reasoning — it applies here unchanged, just swapping pay-order's dead-letter for proposal
 * apply's.
 */
export function proposalApplyHandler(deps: ApplyProposalDeps) {
  return async (jobs: ProposalApplyJob[]): Promise<void> => {
    for (const job of jobs) {
      try {
        await executeApplyProposal(deps, job.data.proposalId)
      } catch (err) {
        if (job.retryCount >= job.retryLimit) {
          try {
            await deadLetterApplyProposal(deps, job.data.proposalId, err)
          } catch (dlqErr) {
            const dlqMessage = dlqErr instanceof Error ? dlqErr.message : String(dlqErr)
            try {
              await deps.alert('critical', 'dead_letter_transition_failed', {
                proposalId: job.data.proposalId,
                error: dlqMessage,
              })
            } catch {
              // Truly nothing left to do — fall through and rethrow the original error below.
            }
          }
        }
        throw err
      }
    }
  }
}
