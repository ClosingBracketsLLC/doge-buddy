import { POLICY_COPY } from '@doge-buddy/core'
import { createDb, orders, proposals, supportMessages, supportTickets } from '@doge-buddy/db'
import { eq, like } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { formAckBody } from '../src/jobs/support-form-ack.ts'
import { validateReplyBody, validateRefundIntent, validateSupportOutput, senderAuthNote, dmarcPasses } from '../src/support/validator.ts'

const url = process.env.DATABASE_URL ?? 'postgres://doge:doge@localhost:5433/doge_buddy'

const SOURCE_WORKFLOW = 'support-validator-test'
const ORDER_PREFIX = 'gid://shopify/Order/valtest-'
const TICKET_PREFIX = 'valtest-'
const MSG_PREFIX = 'valtest-msg-'

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `${Date.now()}-${uidCounter}`
}

describe('support validator', () => {
  const { db, pool } = createDb(url)
  afterAll(() => pool.end())

  afterEach(async () => {
    await db.delete(supportMessages).where(like(supportMessages.gmailMessageId, `${MSG_PREFIX}%`))
    await db.delete(proposals).where(eq(proposals.sourceWorkflow, SOURCE_WORKFLOW))
    await db.delete(supportTickets).where(like(supportTickets.gmailThreadId, `${TICKET_PREFIX}%`))
    await db.delete(orders).where(like(orders.shopifyOrderGid, `${ORDER_PREFIX}%`))
  })

  async function seedOrder(totalCents: number | null): Promise<string> {
    const [row] = await db
      .insert(orders)
      .values({ shopifyOrderGid: `${ORDER_PREFIX}${uid()}`, isTest: true, totalCents })
      .returning({ id: orders.id })
    return row!.id
  }

  async function seedTicket(opts: { customerEmail?: string | null; orderId?: string | null; source?: 'email' | 'form' } = {}): Promise<string> {
    const [row] = await db
      .insert(supportTickets)
      .values({
        gmailThreadId: `${TICKET_PREFIX}${uid()}`,
        customerEmail: opts.customerEmail ?? 'customer@example.com',
        orderId: opts.orderId ?? null,
        ...(opts.source ? { source: opts.source } : {}),
      })
      .returning({ id: supportTickets.id })
    return row!.id
  }

  async function seedInboundMessage(ticketId: string, opts: { authResults?: string | null; sentAt?: Date } = {}): Promise<void> {
    await db.insert(supportMessages).values({
      ticketId,
      gmailMessageId: `${MSG_PREFIX}${uid()}`,
      direction: 'inbound',
      authResults: opts.authResults ?? null,
      sentAt: opts.sentAt ?? new Date(),
    })
  }

  async function seedRefundProposal(opts: {
    ticketId?: string | null
    orderId?: string | null
    status: 'pending' | 'approved' | 'rejected' | 'expired' | 'applying' | 'applied' | 'failed'
    amountCents: number
  }): Promise<string> {
    const [row] = await db
      .insert(proposals)
      .values({
        type: 'refund',
        status: opts.status,
        summary: 'test refund proposal',
        payload: { amountCents: opts.amountCents },
        sourceWorkflow: SOURCE_WORKFLOW,
        ticketId: opts.ticketId ?? null,
        orderId: opts.orderId ?? null,
      })
      .returning({ id: proposals.id })
    return row!.id
  }

  const noRefund = { hasRefundInOutput: false, trackingUrl: null as string | null }

  // -- Plain text checks --

  describe('validateReplyBody: plain text', () => {
    it('rejects a body containing an HTML tag', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Hi <b>there</b>, thanks for writing in.', noRefund)
      expect(result.ok).toBe(false)
    })

    it('rejects a body over 4000 chars', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'a'.repeat(4001), noRefund)
      expect(result.ok).toBe(false)
    })

    it('accepts an ordinary plain-text body, returning the (unchanged) normalizedBody', async () => {
      const ticketId = await seedTicket()
      const body = 'Thanks for reaching out, we will look into it.'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })
  })

  // -- FR5: zero-width / format characters must not defeat any screen --
  // A single default-ignorable format char (U+200B ZWSP, U+FEFF, U+00AD soft hyphen, …) renders
  // invisibly to the customer but breaks every token regex. They are stripped before AND after
  // NFKC, and the returned normalizedBody is the stripped string (what actually gets sent).
  describe('validateReplyBody: zero-width / format character stripping', () => {
    const ZWSP = '\u200B' // zero-width space
    const BOM = '\uFEFF' // zero-width no-break space (BOM)

    it('a promise broken by a ZWSP inside "refund" still trips promised_action (no refund object)', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, `Your ref${ZWSP}und has been issued today.`, noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('promised_action')
    })

    it('a phone number broken by a ZWSP still trips contact_channel', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, `Call 888${ZWSP}5550142 for help.`, noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('contact_channel')
    })

    it('a bare domain broken by a ZWSP still trips url_not_allowed', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, `Visit evil${ZWSP}.com for more.`, noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('url_not_allowed')
    })

    it('a bare domain broken by a U+FEFF (BOM) variant still trips url_not_allowed', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, `Visit evil${BOM}.com for more.`, noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('url_not_allowed')
    })

    it('a legit body with no format chars is unchanged and normalizedBody equals input', async () => {
      const ticketId = await seedTicket()
      const body = 'Thanks for reaching out — we will look into your order and follow up shortly.'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })
  })

  // -- Promised-action screen --

  describe('validateReplyBody: promised-action screen', () => {
    it('hits across a newline within 200 chars ("your refund has been\\nprocessed")', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Good news — your refund has been\nprocessed today.', noRefund)
      expect(result).toEqual({ ok: false, code: 'promised_action', detail: expect.any(String) })
    })

    it('"store credit has been applied" hits', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Your store credit has been applied to your account.', noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('promised_action')
    })

    it('"a free replacement is on its way" hits', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Good news, a free replacement is on its way to you.', noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('promised_action')
    })

    it('policy quote without a refund in output and no live sibling proposal fails', async () => {
      const ticketId = await seedTicket()
      const body = 'Good news — your refund has been processed today.'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: false, code: 'promised_action', detail: expect.any(String) })
    })

    it('the same body passes when a live sibling refund proposal exists for the ticket', async () => {
      const ticketId = await seedTicket()
      await seedRefundProposal({ ticketId, status: 'pending', amountCents: 500 })
      const body = 'Good news — your refund has been processed today.'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    it('the same body passes when hasRefundInOutput is true (no sibling needed)', async () => {
      const ticketId = await seedTicket()
      const body = 'Good news — your refund has been processed today.'
      const result = await validateReplyBody(db, ticketId, body, { hasRefundInOutput: true, trackingUrl: null })
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    it('a sibling proposal in a non-live status (rejected) does not excuse the promised-action hit', async () => {
      const ticketId = await seedTicket()
      await seedRefundProposal({ ticketId, status: 'rejected', amountCents: 500 })
      const body = 'Good news — your refund has been processed today.'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('promised_action')
    })

    it('a body with no action/promise proximity passes', async () => {
      const ticketId = await seedTicket()
      const body = 'Thanks so much for your patience while our team looks into this.'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    // I3 (ruled): extended ACTION/PROMISE token families — natural phrasings the reviewer found
    // that the original token lists missed. Each MUST be caught when there's no refund object and
    // no live sibling proposal. (N2 review swapped bare `i've`/`funds` for `gone ahead and`/
    // `funds back` — see the two affected phrases' comments below and the validator's doc comments.)
    const mustCatchPhrases = [
      'You have been refunded $19.99 to your original payment method.',
      "We've refunded your order in full.",
      "I've gone ahead and refunded you.", // caught via "gone ahead and" (PROMISE), not bare "i've"
      'Your refund is complete.',
      'Refund complete — expect it in 3-5 days.',
      'Your refund is on the way.',
      'We have cancelled your order.',
      'Your order has been cancelled.',
      'A replacement has shipped.',
      'Expect the funds back in 5 business days.', // caught via "funds back" (ACTION), not bare "funds"
      // In-progress / imminent unbacked promises (adversarial review 2026-08-30): just as much a
      // "money is coming" statement as a completed one, so the resolution-gated auxiliaries must
      // catch these too. Each pairs a `has been`/`we've`/`we have` gate with an in-progress money verb.
      'Your refund has been initiated.',
      'Your refund has been submitted to your bank.',
      'Your refund has been authorized.',
      "We've started your refund.",
      'We have begun processing your refund.',
      'Your refund will be credited to your account within 3 business days.',
      "Within 5 business days you'll see the money back in your account.", // reversed receipt-timeframe
      // Coupon / discount-code promises (owner strategy 2026-08-30: decline refunds and returns,
      // offer a discount code instead). The agent has NO tool that issues a code, so any phrasing
      // that says one has been issued/sent/applied is an unbacked promise like any other.
      "We've issued you a 15% discount code.",
      'Your coupon has been sent to your email.',
      'A discount code is on its way to you.',
      "I've applied a 15% discount to your order.",
      'Your promo code will be emailed within 24 hours.',
    ]
    for (const phrase of mustCatchPhrases) {
      it(`"${phrase}" is caught by the extended promised-action screen`, async () => {
        const ticketId = await seedTicket()
        const result = await validateReplyBody(db, ticketId, phrase, noRefund)
        expect(result.ok).toBe(false)
        expect((result as { code: string }).code).toBe('promised_action')
      })
    }

    // Explicitly documented as an accepted gap (I3 ruling): "Consider it refunded." has no
    // ACTION+PROMISE proximity under the enumerated token screen — it stays uncaught.
    it('"Consider it refunded." is NOT caught (enumerated screen, accepted gap)', async () => {
      const ticketId = await seedTicket()
      const body = 'Consider it refunded.'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    it('the extended tokens do not false-positive on ordinary policy language', async () => {
      const ticketId = await seedTicket()
      const body = 'We have received your message and will take a look shortly.'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    // N2 (ruled): dropped bare `i've` from PROMISE and bare `funds` from ACTION — a re-review found
    // they false-positived ordinary refund-denial and diagnostic-question replies (7 of 13
    // realistic non-promise replies were failing). `gone ahead and` and `funds back` (added above)
    // still catch the two phrases they were meant for (see mustCatchPhrases). These seven, verbatim
    // from the reviewer, must now behave as ruled: five PASS, two are accepted false positives
    // (still CAUGHT — each has an unrelated PROMISE token, `we have`, genuinely in-window with an
    // ACTION token, which the enumerated screen can't distinguish from a real promise).
    it('"I\'ve reviewed your order and unfortunately we can\'t offer a refund under our 30-day policy." passes (denial, not a promise)', async () => {
      const ticketId = await seedTicket()
      const body = "I've reviewed your order and unfortunately we can't offer a refund under our 30-day policy."
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    it('"I\'ve attached our refund policy for reference." passes', async () => {
      const ticketId = await seedTicket()
      const body = "I've attached our refund policy for reference."
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    it('"I\'ve asked our warehouse about a replacement and will follow up." passes', async () => {
      const ticketId = await seedTicket()
      const body = "I've asked our warehouse about a replacement and will follow up."
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    // Policy-explanation cleanup (2026-08-30): these two were formerly ACCEPTED false positives —
    // `we have` matched near an ACTION token in a reply that promises nothing. Now that `we have`
    // only counts when a resolution verb follows it (`we have refunded`), both correctly PASS.
    it('"We have received your request for a replacement and will review it." PASSES (we-have not followed by a resolution verb)', async () => {
      const ticketId = await seedTicket()
      const body = 'We have received your request for a replacement and will review it.'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    it('"We have no record of a refund request on this order." PASSES (we-have not followed by a resolution verb)', async () => {
      const ticketId = await seedTicket()
      const body = 'We have no record of a refund request on this order.'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    // Policy-explanation cleanup (2026-08-30): the false positive found on the FIRST real live
    // draft. A refund/return POLICY EXPLANATION must pass — it promises nothing.
    it('a returns-POLICY explanation passes (within-N-days + refund + "has been opened" are policy, not a promise)', async () => {
      const ticketId = await seedTicket()
      const body =
        'Returns are accepted within 30 days of delivery, but the item needs to be unopened, unused, ' +
        'and still sealed in its original manufacturer packaging to qualify for a refund. If the item ' +
        "has been opened or used, we're unable to process a return for it."
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    it('a return DECLINE that quotes the 30-day window passes (no promise)', async () => {
      const ticketId = await seedTicket()
      const body =
        "Unfortunately we can't offer a refund for an item that simply wasn't to your dog's taste — " +
        'returns are only accepted within 30 days for unopened, unused products.'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    // Quoting the STANDING discount code (it already exists in Shopify — nothing is being promised)
    // must pass, in every phrasing the agent is likely to use when declining a refund/return.
    const standingCodePhrasings = [
      'Use code SORRY10 for 10% off your next order.',
      "Here's a discount code for a future order: SORRY10.",
      "We can't offer a refund or a return, but here's a discount code for your next order: SORRY10 (10% off, one use per customer).",
      "All sales are final, so I can't set up a return — but please use coupon SORRY10 for 10% off next time.",
    ]
    for (const body of standingCodePhrasings) {
      it(`"${body.slice(0, 60)}…" passes (quoting the standing code promises no action)`, async () => {
        const ticketId = await seedTicket()
        const result = await validateReplyBody(db, ticketId, body, noRefund)
        expect(result).toEqual({ ok: true, normalizedBody: body })
      })
    }

    // The agent quotes POLICY_COPY verbatim (it is the ONLY source it may cite), so no policy
    // paragraph may ever trip a screen — or a perfectly faithful draft gets escalated. This guards
    // every future policy edit: wording like "once it's on its way back" or "once you've shipped it"
    // reads naturally but carries a promise token next to an ACTION token.
    for (const policy of POLICY_COPY) {
      for (const section of policy.sections) {
        for (const paragraph of section.paragraphs) {
          it(`policy paragraph passes verbatim: "${paragraph.slice(0, 60)}…"`, async () => {
            const ticketId = await seedTicket()
            const result = await validateReplyBody(db, ticketId, paragraph, noRefund)
            expect(result).toEqual({ ok: true, normalizedBody: paragraph })
          })
        }
      }
    }

    it('the contact-form ack copy passes the reply screens verbatim', async () => {
      const r = await validateReplyBody(db, await seedTicket(), formAckBody('Rob'), noRefund)
      expect(r.ok).toBe(true)
    })

    // But a REAL refund promise phrased as a receipt-timeframe MUST still be caught.
    it('"You\'ll see your refund back within 5 business days." is CAUGHT (receipt-timeframe promise)', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, "You'll see your refund back within 5 business days.", noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('promised_action')
    })

    it('"Your refund will be credited to your card within 3-5 days." is CAUGHT (will be + resolution verb)', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Your refund will be credited to your card within 3-5 days.', noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('promised_action')
    })

    it('"Could you confirm whether the funds have been taken from your account?" passes (no ACTION token once bare funds is dropped)', async () => {
      const ticketId = await seedTicket()
      const body = 'Could you confirm whether the funds have been taken from your account?'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    it('"I\'ve checked with the carrier; the funds are still held by your bank." passes', async () => {
      const ticketId = await seedTicket()
      const body = "I've checked with the carrier; the funds are still held by your bank."
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    // Round-3 cleanup (ruled): `funds back` was dual-listed in ACTION and PROMISE, so it matched
    // itself as its own "promise" at gap 0 — ANY mention of "funds back" self-triggered regardless
    // of context, including a plain question that promises nothing. Dropped from PROMISE_RE (kept
    // in ACTION_RE only); "Expect the funds back..." (below, still in mustCatchPhrases) stays
    // caught via the ACTION token overlapping PROMISE_RE's `expect (...the funds...)`.
    it('"Would you like the funds back on your card?" passes (funds back alone no longer self-matches as a promise)', async () => {
      const ticketId = await seedTicket()
      const body = 'Would you like the funds back on your card?'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    it('"Can I get the funds back today?" passes', async () => {
      const ticketId = await seedTicket()
      const body = 'Can I get the funds back today?'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })
  })

  // -- URL / domain screen --

  describe('validateReplyBody: URL/domain screen', () => {
    const cases: { name: string; body: string; ok: boolean }[] = [
      { name: 'https://dogebuddy.com/track passes', body: 'Track it here: https://dogebuddy.com/track', ok: true },
      { name: 'https://www.dogebuddy.com passes', body: 'Visit https://www.dogebuddy.com for info.', ok: true },
      { name: 'http://dogebuddy.com fails (not https)', body: 'Visit http://dogebuddy.com for info.', ok: false },
      { name: 'https://evil.com fails', body: 'Visit https://evil.com for info.', ok: false },
      { name: 'https://dogebuddy.com.evil.com/x fails', body: 'Visit https://dogebuddy.com.evil.com/x for info.', ok: false },
      { name: 'bare dogebuddy-help.com fails', body: 'Please see dogebuddy-help.com for details.', ok: false },
      { name: 'bare dogebuddy.com passes', body: 'Please see dogebuddy.com for details.', ok: true },
      { name: 'admin.dogebuddy.com fails (subdomain excluded)', body: 'Please see admin.dogebuddy.com for details.', ok: false },
      // C1 regression: a bare `@domain.tld` mention with NO email local part (a Telegram-style
      // handle or off-platform channel, not a real address) must still be caught by the
      // URL/domain screen — the deleted `@`-skip carve-out used to let these straight through.
      { name: '@evil.com (bare, no local part) fails', body: 'Contact @evil.com for help.', ok: false },
      { name: 'Message us at @dogepay.shop fails', body: 'Message us at @dogepay.shop for a faster reply.', ok: false },
      { name: 'Telegram: @refund-help.com fails', body: 'Telegram: @refund-help.com — DM us there.', ok: false },
      // m5: NFKC normalization folds Unicode dot look-alikes to a plain '.' before the domain
      // regexes ever run.
      { name: 'evil․com (U+2024 ONE DOT LEADER) fails', body: 'Please see evil․com for details.', ok: false },
      { name: 'evil．com (U+FF0E FULLWIDTH FULL STOP) fails', body: 'Please see evil．com for details.', ok: false },
      // m4: trailing prose punctuation and a `<...>` wrap are stripped before parsing/comparing.
      { name: 'trailing period after a schemed URL passes', body: 'Track your order at https://dogebuddy.com.', ok: true },
      { name: 'angle-bracket-wrapped URL passes (not HTML)', body: 'See <https://dogebuddy.com/help> for details.', ok: true },
    ]

    for (const c of cases) {
      it(c.name, async () => {
        const ticketId = await seedTicket()
        const result = await validateReplyBody(db, ticketId, c.body, noRefund)
        expect(result.ok).toBe(c.ok)
        if (!c.ok) expect((result as { code: string }).code).toBe('url_not_allowed')
      })
    }

    // C1: with the contact screen now running BEFORE the URL/domain screen, a URL whose userinfo
    // section looks like an email (`dogebuddy.com@evil.com`) is caught by the EMAIL check first —
    // still `ok:false`, just reported as `contact_channel` instead of `url_not_allowed`. Either
    // code is a correct block; this test locks in which one actually fires post-reorder.
    it('https://dogebuddy.com@evil.com/ fails via the contact screen (userinfo looks like an email; real hostname is evil.com)', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Visit https://dogebuddy.com@evil.com/ for info.', noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('contact_channel')
    })

    it('tracking URL byte-equal to opts.trackingUrl passes even off the dogebuddy.com hostname', async () => {
      const ticketId = await seedTicket()
      const trackingUrl = 'https://carrier.example.com/trk?id=ABC123'
      const body = `Track it here: ${trackingUrl}`
      const result = await validateReplyBody(db, ticketId, body, { hasRefundInOutput: false, trackingUrl })
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    it('an off-by-one mismatch against opts.trackingUrl fails', async () => {
      const ticketId = await seedTicket()
      const trackingUrl = 'https://carrier.example.com/trk?id=ABC123'
      const bodyUrl = 'https://carrier.example.com/trk?id=ABC124'
      const result = await validateReplyBody(db, ticketId, `Track it here: ${bodyUrl}`, {
        hasRefundInOutput: false,
        trackingUrl,
      })
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('url_not_allowed')
    })
  })

  // -- Contact screen --

  describe('validateReplyBody: contact screen', () => {
    it('help@gmail.com fails (contact screen runs before URL/domain, per C1)', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'You can also reach us at help@gmail.com any time.', noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('contact_channel')
    })

    // m5/C1: NFKC-normalizing the body before any screen runs means a Unicode dot look-alike used
    // to dodge the literal '.' in EMAIL_RE is folded back to a plain ASCII email first.
    it('help@gmail․com with a U+2024 ONE DOT LEADER still fails as contact_channel', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'You can also reach us at help@gmail․com any time.', noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('contact_channel')
    })

    it('support@dogebuddy.com passes', async () => {
      const ticketId = await seedTicket()
      const body = 'You can also reach us at support@dogebuddy.com any time.'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    it('+1 (888) 555-0142 fails', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Feel free to call us at +1 (888) 555-0142 anytime.', noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('contact_channel')
    })

    it('spaced-digit "8 8 8 5 5 5 0 1 4 2" still fails (separators between every digit)', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Call us at 8 8 8 5 5 5 0 1 4 2 any time.', noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('contact_channel')
    })

    // N1 (ruled): a standalone (non-alphanumeric-bounded) run of EXACTLY 10 or 11 digits is
    // phone-like even with NO leading +/( and NO interior separators at all — the old
    // separator-or-prefix rule alone let these straight through.
    it('"Please call 8885550142 for faster service." fails (standalone 10-digit run)', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Please call 8885550142 for faster service.', noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('contact_channel')
    })

    it('"Call 18885550142 anytime." fails (standalone 11-digit run)', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Call 18885550142 anytime.', noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('contact_channel')
    })

    // Round-3 fix: ISO_DATE_SPAN_RE was unanchored, so it could match a 4-2-2 SLICE of a longer,
    // non-date digit-dash run (a phone number regrouped as 4-2-2), wrongly exempting most of its
    // digits and letting the whole thing slip the phone screen. Now digit-anchored on both ends.
    it('"Call 5551-23-4567 today" fails (4-2-2-regrouped phone number, not a real ISO date)', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Call 5551-23-4567 today', noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('contact_channel')
    })

    it('"Reach me at +1 8885-55-0142" fails (4-2-2-regrouped phone number with country code)', async () => {
      const ticketId = await seedTicket()
      const result = await validateReplyBody(db, ticketId, 'Reach me at +1 8885-55-0142', noRefund)
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('contact_channel')
    })

    it('a 10-digit run embedded in an alphanumeric reference id passes (bounded by a letter, not standalone)', async () => {
      const ticketId = await seedTicket()
      const body = 'Your reference is REF1234567890 for tracking.'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    it('"order #12345" passes (digits < 7 with separators)', async () => {
      const ticketId = await seedTicket()
      const body = 'Please reference order #12345 when you write back.'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    // I2 ruling: a single unseparated digit run with no leading +/( is not phone-like, no matter
    // how long — it's an order/tracking number, not a phone number. (8 digits — N1's 10/11-digit
    // standalone rule doesn't apply either.)
    it('"Order 10023481 shipped" passes (unseparated digit run, no leading +/()', async () => {
      const ticketId = await seedTicket()
      const body = 'Order 10023481 shipped'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    // I2 ruling: a bare alphanumeric tracking token (letters interleaved with digits) is not
    // phone-like — the embedded unseparated digit run alone doesn't qualify either. N1's
    // standalone-run rule also doesn't apply: the 11-digit run is bounded by a letter ('A'), not
    // non-alphanumeric characters.
    it('"Your tracking number is 1Z999AA10123456784." passes', async () => {
      const ticketId = await seedTicket()
      const body = 'Your tracking number is 1Z999AA10123456784.'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    it('ISO dates "Ordered on 2024-01-15 and shipped 2024-01-18." pass (excluded explicitly)', async () => {
      const ticketId = await seedTicket()
      const body = 'Ordered on 2024-01-15 and shipped 2024-01-18.'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    // ALSO (a): ISO dates are exempted digit-by-digit (a span-based exemption), not by requiring
    // the WHOLE phone-candidate to exactly equal one date — two adjacent dates joined by a single
    // space (which PHONE_RE's own character class allows, merging them into ONE candidate match)
    // still have every digit correctly excluded.
    it('"Window: 2024-01-15 2024-01-18" passes (two adjacent ISO dates merged into one phone-regex candidate)', async () => {
      const ticketId = await seedTicket()
      const body = 'Window: 2024-01-15 2024-01-18'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    it('"Dates: 2024-01-15 2024-01-18 2024-01-20" passes (three adjacent ISO dates merged into one candidate)', async () => {
      const ticketId = await seedTicket()
      const body = 'Dates: 2024-01-15 2024-01-18 2024-01-20'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    it('a long digit run inside an allowed dogebuddy.com URL path passes (allowedSpans-aware)', async () => {
      const ticketId = await seedTicket()
      const body = 'Your tracking link: https://dogebuddy.com/track/9405511899223197428490'
      const result = await validateReplyBody(db, ticketId, body, noRefund)
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })

    it('a byte-equal tracking URL containing separated digits passes (allowedSpans exempts it from the phone screen too)', async () => {
      const ticketId = await seedTicket()
      const trackingUrl = 'https://carrier.example.com/trk?ref=1-800-555-0199#nums=LZ123456789CN'
      const body = `Track it here: ${trackingUrl}`
      const result = await validateReplyBody(db, ticketId, body, { hasRefundInOutput: false, trackingUrl })
      expect(result).toEqual({ ok: true, normalizedBody: body })
    })
  })

  // -- validateRefundIntent --
  // (validateRefundIntent never populates normalizedBody — it screens no reply body — so its
  // `{ ok: true }` assertions below are unchanged by the normalizedBody addition.)

  describe('validateRefundIntent', () => {
    it('fails refund_unverified_order when ticket.orderId is null', async () => {
      const result = await validateRefundIntent(
        db,
        { id: 'ignored', orderId: null },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result).toEqual({ ok: false, code: 'refund_unverified_order', detail: expect.any(String) })
    })

    it('fails refund_unverified_order when the order row totalCents is null', async () => {
      const orderId = await seedOrder(null)
      const result = await validateRefundIntent(
        db,
        { id: 'ignored', orderId },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('refund_unverified_order')
    })

    it('fails refund_exceeds_total on accumulation: $10 already applied + $15 new on a $20 order', async () => {
      const orderId = await seedOrder(2000)
      await seedRefundProposal({ orderId, status: 'applied', amountCents: 1000 })
      const result = await validateRefundIntent(
        db,
        { id: 'ignored', orderId },
        { amountCents: 1500, openCjDispute: false },
      )
      expect(result).toEqual({ ok: false, code: 'refund_exceeds_total', detail: expect.any(String) })
    })

    it('fails refund_exceeds_total when the new amount alone exceeds the order total', async () => {
      const orderId = await seedOrder(1000)
      const result = await validateRefundIntent(
        db,
        { id: 'ignored', orderId },
        { amountCents: 1500, openCjDispute: false },
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('refund_exceeds_total')
    })

    // A `pending`/`approved`/`applying` refund is money the owner is one tap away from moving (an
    // approved one is already enqueued for apply). Counting only `applied` would let a second
    // refund be drafted, approved, and applied on top of a first that lands moments later.
    it.each(['pending', 'approved', 'applying'] as const)(
      'counts a prior %s refund toward the accumulation bound',
      async (status) => {
        const orderId = await seedOrder(2000)
        await seedRefundProposal({ orderId, status, amountCents: 1900 })
        const ticketId = await seedTicket({ orderId })
        await seedInboundMessage(ticketId, { authResults: 'dkim=pass; dmarc=pass' })
        const result = await validateRefundIntent(
          db,
          { id: ticketId, orderId },
          { amountCents: 1500, openCjDispute: false },
        )
        expect(result.ok).toBe(false)
        expect((result as { code: string }).code).toBe('refund_exceeds_total')
      },
    )

    // Fix round 1 (Task 18 review), CRITICAL 1: at APPROVE time the row being approved is itself
    // `pending` — one of the LIVE statuses the bound sums — so without excluding it, it counts
    // against its own total and the bound degenerates to `amount > total - amount`. Reproduced
    // here exactly: a 100%-of-total ($50-on-$50) refund failed `refund_exceeds_total` with
    // "remaining 0c" before the fix.
    describe('excludeProposalId (self-exclusion at approve time)', () => {
      it('a 100%-of-total refund succeeds when the row being approved excludes itself from the bound', async () => {
        const orderId = await seedOrder(5000)
        const ticketId = await seedTicket({ orderId })
        await seedInboundMessage(ticketId, { authResults: 'dmarc=pass' })
        const ownProposalId = await seedRefundProposal({ orderId, ticketId, status: 'pending', amountCents: 5000 })

        const result = await validateRefundIntent(
          db,
          { id: ticketId, orderId },
          { amountCents: 5000, openCjDispute: false },
          ownProposalId,
        )
        expect(result).toEqual({ ok: true })
      })

      it('without excludeProposalId, the same 100%-of-total refund fails (regression check on the bug itself)', async () => {
        const orderId = await seedOrder(5000)
        const ticketId = await seedTicket({ orderId })
        await seedInboundMessage(ticketId, { authResults: 'dmarc=pass' })
        await seedRefundProposal({ orderId, ticketId, status: 'pending', amountCents: 5000 })

        const result = await validateRefundIntent(db, { id: ticketId, orderId }, { amountCents: 5000, openCjDispute: false })
        expect(result.ok).toBe(false)
        expect((result as { code: string }).code).toBe('refund_exceeds_total')
      })

      it('exclusion is only of SELF: a genuine second live refund proposal on the same order still blocks', async () => {
        const orderId = await seedOrder(5000)
        const ticketId = await seedTicket({ orderId })
        await seedInboundMessage(ticketId, { authResults: 'dmarc=pass' })
        await seedRefundProposal({ orderId, ticketId, status: 'approved', amountCents: 1000 })
        const ownProposalId = await seedRefundProposal({ orderId, ticketId, status: 'pending', amountCents: 4500 })

        const result = await validateRefundIntent(
          db,
          { id: ticketId, orderId },
          { amountCents: 4500, openCjDispute: false },
          ownProposalId,
        )
        expect(result.ok).toBe(false)
        expect((result as { code: string }).code).toBe('refund_exceeds_total')
      })
    })

    it('does not count rejected, expired, or failed prior proposals toward the bound', async () => {
      const orderId = await seedOrder(2000)
      await seedRefundProposal({ orderId, status: 'rejected', amountCents: 1900 })
      await seedRefundProposal({ orderId, status: 'expired', amountCents: 1900 })
      await seedRefundProposal({ orderId, status: 'failed', amountCents: 1900 })
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: 'dkim=pass; dmarc=pass' })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 1500, openCjDispute: false },
      )
      expect(result).toEqual({ ok: true })
    })

    it('fails refund_sender_unauthenticated when the latest inbound message has auth_results null', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: null })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result).toEqual({ ok: false, code: 'refund_sender_unauthenticated', detail: expect.any(String) })
    })

    // Final review I8 — same refusal, honest reason. A contact-form ticket's first inbound is a web
    // submission with no Authentication-Results header at all, so "not dmarc=pass authenticated"
    // read like a FORGED sender instead of "this customer has never emailed us yet".
    it("a source='form' ticket whose only inbound has NULL auth_results gets the contact-form reason (still a refusal)", async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId, source: 'form' })
      await seedInboundMessage(ticketId, { authResults: null })
      const result = await validateRefundIntent(db, { id: ticketId, orderId }, { amountCents: 500, openCjDispute: false })
      expect(result).toEqual({
        ok: false,
        code: 'refund_sender_unauthenticated',
        detail: 'contact-form ticket: no authenticated sender until the customer replies by email',
      })
    })

    it("a source='form' ticket whose latest inbound DOES carry a header keeps the generic reason (a real dmarc failure is not a form artefact)", async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId, source: 'form' })
      await seedInboundMessage(ticketId, { authResults: 'dkim=pass; dmarc=fail (p=REJECT)' })
      const result = await validateRefundIntent(db, { id: ticketId, orderId }, { amountCents: 500, openCjDispute: false })
      expect(result).toEqual({
        ok: false,
        code: 'refund_sender_unauthenticated',
        detail: 'latest inbound message is not dmarc=pass authenticated',
      })
    })

    it('fails refund_sender_unauthenticated when the latest inbound message auth_results does not contain dmarc=pass', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: 'dkim=pass; dmarc=fail (p=REJECT)' })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('refund_sender_unauthenticated')
    })

    // Fix round 1 (Task 18 review), M7: `senderAuthNote` (the display helper submit.ts's Telegram
    // body and the admin refund summary both now use) must reuse the EXACT word-bounded regex
    // this gate enforces — before the fix, those two display call sites re-typed `/dmarc=pass/i`
    // with no word boundaries, which would have shown "verified" for a crafted `xdmarc=pass`
    // header that this gate correctly refuses.
    it('senderAuthNote: a word-embedded "xdmarc=pass" is NOT treated as verified (word-boundary match, same as the gate)', () => {
      expect(senderAuthNote('xdmarc=pass')).toBe('auth: NOT verified')
      expect(senderAuthNote('dkim=pass; dmarc=pass; spf=pass')).toBe('auth: dmarc=pass')
      expect(senderAuthNote(null)).toBe('auth: NOT verified')
    })

    it('the gate itself refuses the same crafted "xdmarc=pass" header (regression pin for the M7 helper extraction)', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: 'xdmarc=pass' })
      const result = await validateRefundIntent(db, { id: ticketId, orderId }, { amountCents: 500, openCjDispute: false })
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('refund_sender_unauthenticated')
    })

    // FR1: the gate PARSES the top-level dmarc method result — a `dmarc=pass` substring inside an
    // attacker-influenceable param (smtp.mailfrom) must NOT pass. Forged strings from the reviewer.
    const FORGED_GOOGLE_AR =
      'mx.google.com; dkim=pass header.i=@evil.example; spf=pass (google.com: domain of dmarc=pass@evil.example ' +
      'designates 1.2.3.4 as permitted sender) smtp.mailfrom=dmarc=pass@evil.example; ' +
      'dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=victim.example'
    const GENUINE_GOOGLE_AR =
      'mx.google.com; dkim=pass header.i=@x.example header.s=sel; spf=pass (google.com: domain of a@x.example) ' +
      'smtp.mailfrom=a@x.example; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=x.example'
    const QUOTED_LOCALPART_AR =
      'mx.google.com; spf=pass (google.com: domain of "x;dmarc=pass"@evil.example designates 1.2.3.4 as permitted ' +
      'sender) smtp.mailfrom="x;dmarc=pass"@evil.example; dmarc=fail (p=NONE) header.from=victim.example'

    describe('dmarcPasses parses the top-level dmarc method result (FR1)', () => {
      it('the forged Google-shaped smtp.mailfrom=dmarc=pass header is NOT pass (Gmail stamped dmarc=fail)', () => {
        expect(dmarcPasses(FORGED_GOOGLE_AR)).toBe(false)
      })
      it('a genuine dmarc=pass method IS pass', () => {
        expect(dmarcPasses(GENUINE_GOOGLE_AR)).toBe(true)
      })
      it('the quoted-local-part "x;dmarc=pass"@evil forgery is NOT pass', () => {
        expect(dmarcPasses(QUOTED_LOCALPART_AR)).toBe(false)
      })
      it('null / empty auth_results is NOT pass', () => {
        expect(dmarcPasses(null)).toBe(false)
        expect(dmarcPasses('')).toBe(false)
      })
      it('a word-embedded xdmarc=pass clause is NOT pass', () => {
        expect(dmarcPasses('xdmarc=pass')).toBe(false)
      })
      it('a plain dmarc=pass with trailing params after whitespace IS pass', () => {
        expect(dmarcPasses('dkim=pass; dmarc=pass action=none')).toBe(true)
      })
    })

    it('the refund gate refuses the forged Google-shaped header (money-path regression pin, FR1)', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: FORGED_GOOGLE_AR })
      const result = await validateRefundIntent(db, { id: ticketId, orderId }, { amountCents: 500, openCjDispute: false })
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('refund_sender_unauthenticated')
    })

    it('the refund gate accepts a genuine dmarc=pass header (FR1 happy path)', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: GENUINE_GOOGLE_AR })
      const result = await validateRefundIntent(db, { id: ticketId, orderId }, { amountCents: 500, openCjDispute: false })
      expect(result).toEqual({ ok: true })
    })

    it('fails refund_sender_unauthenticated when there is no inbound message at all', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('refund_sender_unauthenticated')
    })

    it('uses the LATEST inbound message, not an earlier authenticated one', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: 'dmarc=pass', sentAt: new Date('2024-01-01T00:00:00Z') })
      await seedInboundMessage(ticketId, { authResults: null, sentAt: new Date('2024-02-01T00:00:00Z') })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('refund_sender_unauthenticated')
    })

    it('treats a NULL-sentAt row as older than a timestamped row (NULLS LAST), not as the latest', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      // A NULL sentAt row with no auth — if this sorted first under DESC, the check would
      // wrongly fail even though a real, authenticated message exists.
      await db.insert(supportMessages).values({
        ticketId,
        gmailMessageId: `${MSG_PREFIX}${uid()}`,
        direction: 'inbound',
        authResults: null,
        sentAt: null,
      })
      await seedInboundMessage(ticketId, { authResults: 'dmarc=pass', sentAt: new Date('2024-03-01T00:00:00Z') })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result).toEqual({ ok: true })
    })

    it('fails when openCjDispute is true but cjDisputeReasonId is missing', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: 'dmarc=pass' })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: true },
      )
      expect(result.ok).toBe(false)
    })

    it('passes when openCjDispute is true and cjDisputeReasonId is present', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: 'dmarc=pass' })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: true, cjDisputeReasonId: 'reason-1' },
      )
      expect(result).toEqual({ ok: true })
    })

    it('happy path: verified order, within total, authenticated sender, no dispute → passes', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: 'dkim=pass; dmarc=pass action=none' })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result).toEqual({ ok: true })
    })

    // m8 boundary: amountCents exactly equal to the remaining balance (total − prior applied) is
    // allowed; one cent over fails.
    it('boundary: amountCents exactly equal to the remaining balance passes', async () => {
      const orderId = await seedOrder(2000)
      await seedRefundProposal({ orderId, status: 'applied', amountCents: 500 })
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: 'dmarc=pass' })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 1500, openCjDispute: false }, // remaining = 2000 - 500 = 1500
      )
      expect(result).toEqual({ ok: true })
    })

    it('boundary: remaining balance + 1 cent fails', async () => {
      const orderId = await seedOrder(2000)
      await seedRefundProposal({ orderId, status: 'applied', amountCents: 500 })
      const ticketId = await seedTicket({ orderId })
      await seedInboundMessage(ticketId, { authResults: 'dmarc=pass' })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 1501, openCjDispute: false }, // remaining = 1500, one cent over
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('refund_exceeds_total')
    })

    // m9: the ORDER BY tiebreak (created_at DESC, id DESC after sentAt DESC NULLS LAST) makes
    // "latest inbound message" deterministic even when two rows share the exact same sentAt.
    it('tiebreaks same-sentAt rows by created_at DESC: the later-created row wins', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      const sameSentAt = new Date('2024-05-01T00:00:00Z')
      await db.insert(supportMessages).values({
        ticketId,
        gmailMessageId: `${MSG_PREFIX}${uid()}`,
        direction: 'inbound',
        authResults: null,
        sentAt: sameSentAt,
        createdAt: new Date('2024-05-01T00:00:01Z'),
      })
      await db.insert(supportMessages).values({
        ticketId,
        gmailMessageId: `${MSG_PREFIX}${uid()}`,
        direction: 'inbound',
        authResults: 'dmarc=pass',
        sentAt: sameSentAt,
        createdAt: new Date('2024-05-01T00:00:05Z'), // later created_at — this one should win
      })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result).toEqual({ ok: true })
    })

    it('tiebreaks same-sentAt rows by created_at DESC: the earlier-created row is correctly ignored', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId })
      const sameSentAt = new Date('2024-05-01T00:00:00Z')
      await db.insert(supportMessages).values({
        ticketId,
        gmailMessageId: `${MSG_PREFIX}${uid()}`,
        direction: 'inbound',
        authResults: 'dmarc=pass',
        sentAt: sameSentAt,
        createdAt: new Date('2024-05-01T00:00:01Z'), // earlier created_at
      })
      await db.insert(supportMessages).values({
        ticketId,
        gmailMessageId: `${MSG_PREFIX}${uid()}`,
        direction: 'inbound',
        authResults: null,
        sentAt: sameSentAt,
        createdAt: new Date('2024-05-01T00:00:05Z'), // later created_at — this one wins, and it's unauthenticated
      })
      const result = await validateRefundIntent(
        db,
        { id: ticketId, orderId },
        { amountCents: 500, openCjDispute: false },
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('refund_sender_unauthenticated')
    })
  })

  // -- validateSupportOutput composition --

  describe('validateSupportOutput', () => {
    it('rejects a propose outcome when ticket.customerEmail is null', async () => {
      const ticketId = await seedTicket()
      const result = await validateSupportOutput(
        db,
        { id: ticketId, orderId: null, customerEmail: null },
        { outcome: 'propose', reply: { body: 'Thanks for writing in.' }, rationale: 'x' },
      )
      expect(result.ok).toBe(false)
    })

    it('passes an escalate outcome straight through with no reply/refund checks (no normalizedBody — no reply body involved)', async () => {
      const ticketId = await seedTicket()
      const result = await validateSupportOutput(
        db,
        { id: ticketId, orderId: null, customerEmail: null },
        { outcome: 'escalate', escalationReason: 'legal threat', rationale: 'x' },
      )
      expect(result).toEqual({ ok: true })
    })

    it('passes a no_action outcome straight through (no normalizedBody)', async () => {
      const ticketId = await seedTicket()
      const result = await validateSupportOutput(
        db,
        { id: ticketId, orderId: null, customerEmail: null },
        { outcome: 'no_action', rationale: 'x' },
      )
      expect(result).toEqual({ ok: true })
    })

    it('surfaces a reply-body URL violation for a propose outcome', async () => {
      const ticketId = await seedTicket()
      const result = await validateSupportOutput(
        db,
        { id: ticketId, orderId: null, customerEmail: 'customer@example.com' },
        { outcome: 'propose', reply: { body: 'Please visit https://evil.com to continue.' }, rationale: 'x' },
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('url_not_allowed')
    })

    it('surfaces a refund cross-check failure for a propose outcome with refund', async () => {
      const orderId = await seedOrder(1000)
      const ticketId = await seedTicket({ orderId, customerEmail: 'customer@example.com' })
      await seedInboundMessage(ticketId, { authResults: 'dmarc=pass' })
      const result = await validateSupportOutput(
        db,
        { id: ticketId, orderId, customerEmail: 'customer@example.com' },
        {
          outcome: 'propose',
          reply: { body: 'Your refund is on the way once approved by a human.' },
          refund: { amountCents: 1500, reason: 'damaged', openCjDispute: false },
          rationale: 'x',
        },
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('refund_exceeds_total')
    })

    it('happy path: propose with a clean reply and a valid refund passes end to end, returning normalizedBody', async () => {
      const orderId = await seedOrder(2000)
      const ticketId = await seedTicket({ orderId, customerEmail: 'customer@example.com' })
      await seedInboundMessage(ticketId, { authResults: 'dmarc=pass' })
      const replyBody = 'Thanks for reaching out — we have processed a refund pending approval.'
      const result = await validateSupportOutput(
        db,
        { id: ticketId, orderId, customerEmail: 'customer@example.com' },
        {
          outcome: 'propose',
          reply: { body: replyBody },
          refund: { amountCents: 500, reason: 'damaged', openCjDispute: false },
          rationale: 'x',
        },
      )
      expect(result).toEqual({ ok: true, normalizedBody: replyBody })
    })

    // m7: validateSupportOutput's optional 4th trackingUrl param threads through to
    // validateReplyBody, so a legitimate off-domain carrier tracking link in the reply passes.
    it('threads an explicit trackingUrl param through to the reply-body URL/contact screens', async () => {
      const ticketId = await seedTicket({ customerEmail: 'customer@example.com' })
      const trackingUrl = 'https://carrier.example.com/trk?id=XYZ789'
      const replyBody = `Track it here: ${trackingUrl}`
      const result = await validateSupportOutput(
        db,
        { id: ticketId, orderId: null, customerEmail: 'customer@example.com' },
        { outcome: 'propose', reply: { body: replyBody }, rationale: 'x' },
        trackingUrl,
      )
      expect(result).toEqual({ ok: true, normalizedBody: replyBody })
    })

    it('without an explicit trackingUrl argument, the same off-domain URL fails (default null, unchanged behavior)', async () => {
      const ticketId = await seedTicket({ customerEmail: 'customer@example.com' })
      const trackingUrl = 'https://carrier.example.com/trk?id=XYZ789'
      const result = await validateSupportOutput(
        db,
        { id: ticketId, orderId: null, customerEmail: 'customer@example.com' },
        { outcome: 'propose', reply: { body: `Track it here: ${trackingUrl}` }, rationale: 'x' },
      )
      expect(result.ok).toBe(false)
      expect((result as { code: string }).code).toBe('url_not_allowed')
    })
  })
})
