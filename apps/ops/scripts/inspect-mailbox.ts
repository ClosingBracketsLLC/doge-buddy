import { createGmailAuth, createGmailClient } from '@doge-buddy/gmail'
import { loadConfig } from '../src/config.ts'
import { loadDotEnv } from '../src/load-env.ts'

/**
 * Read-only inspector for the live support mailbox, using the SAME client + creds ops runs with.
 * Built for the 6B Tier-2 walk (2026-08-30): it is how Claude verifies from this side that an
 * approved reply actually went out, threaded (`In-Reply-To`/`References`), `From: support@`, and
 * that the `X-DogeBuddy-Proposal` send-recovery marker round-trips through Gmail (check 1a).
 * Never writes — no labels, no sends, no modifies.
 *
 *   pnpm --filter @doge-buddy/ops inspect-mailbox recent ['<gmail search, default newer_than:2d>']
 *   pnpm --filter @doge-buddy/ops inspect-mailbox thread <gmailThreadId>
 *   pnpm --filter @doge-buddy/ops inspect-mailbox msg <gmailMessageId>      (format=full, body head)
 */
if (loadDotEnv(import.meta.url)) {
  console.log('inspect-mailbox: loaded apps/ops/.env (existing environment variables take precedence)')
}
const config = loadConfig(process.env)
if (!config.gmail) {
  console.error('inspect-mailbox: GMAIL_* / SUPPORT_ADDRESS are not configured')
  process.exit(1)
}
const gmail = createGmailClient({
  auth: createGmailAuth({
    saEmail: config.gmail.saEmail,
    saKey: config.gmail.saKey,
    impersonate: config.gmail.impersonate,
  }),
  fromAddress: config.gmail.supportAddress,
})

const [mode = 'recent', arg] = process.argv.slice(2)
const short = (v: string | null, n = 120) => (v ? (v.length > n ? `${v.slice(0, n)}…` : v) : null)

const profile = await gmail.getProfile()
console.log(`profile: ${profile.emailAddress} historyId=${profile.historyId}`)

if (mode === 'recent') {
  const q = arg ?? 'newer_than:2d'
  const { ids } = await gmail.listMessages({ q, includeSpamTrash: true })
  console.log(`messages matching "${q}" (incl. spam/trash): ${ids.length}`)
  for (const { id } of ids.slice(0, 25)) {
    const m = await gmail.getMessage(id, { format: 'metadata' })
    console.log(
      `- ${m.internalDate.toISOString()} id=${m.id} thread=${m.threadId} labels=${m.labelIds.join(',')}\n` +
        `    from=${m.fromRaw} to=${m.to.join(',')} subj=${JSON.stringify(m.subject)}\n` +
        `    msgid=${m.rfcMessageId} inReplyTo=${m.inReplyTo} refs=${short(m.references)}\n` +
        `    marker=${m.dogeBuddyProposalId} auth=${short(m.authenticationResults, 90)}`,
    )
  }
} else if (mode === 'thread') {
  if (!arg) throw new Error('thread mode needs a gmail thread id')
  const t = await gmail.getThread(arg)
  for (const { id } of t.messages) {
    const m = await gmail.getMessage(id, { format: 'metadata' })
    console.log(
      `- ${m.internalDate.toISOString()} id=${m.id} from=${m.fromRaw} subj=${JSON.stringify(m.subject)} labels=${m.labelIds.join(',')}\n` +
        `    msgid=${m.rfcMessageId} inReplyTo=${m.inReplyTo} refs=${short(m.references)} marker=${m.dogeBuddyProposalId}`,
    )
  }
} else if (mode === 'msg') {
  if (!arg) throw new Error('msg mode needs a gmail message id')
  const m = await gmail.getMessage(arg, { format: 'full' })
  const { bodyText, ...rest } = m
  console.log(JSON.stringify(rest, null, 2))
  console.log('--- body (first 2000 chars) ---')
  console.log(bodyText?.slice(0, 2000) ?? '(no text body)')
} else {
  throw new Error(`unknown mode "${mode}" — use recent | thread <id> | msg <id>`)
}
