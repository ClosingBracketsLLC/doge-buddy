import { auditLog, proposals, type createDb } from '@doge-buddy/db'
import { eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import type { SendOpts } from '../../fulfillment/types.ts'
import type { NotifyOwner } from '../../notify/notify.ts'
import { enqueueProposalApply, PAYLOAD_SCHEMAS } from '../../proposals/submit.ts'
import { applyProposalTransition, StaleProposalStatusError } from '../../proposals/transitions.ts'
import type { Settings } from '../../settings.ts'
import {
  consumeLoginToken,
  createLoginToken,
  LOGIN_SENDS_HOURLY_CAP,
  loginSendsLastHour,
  parseCookieHeader,
  serializeSessionCookie,
  SESSION_COOKIE,
  validateSession,
} from './auth.ts'
import { html, layout } from './html.ts'

type Db = ReturnType<typeof createDb>['db']
type Alert = (severity: 'info' | 'warning' | 'critical', kind: string, detail: Record<string, unknown>) => Promise<void>

export interface AdminDeps {
  db: Db
  settings: Settings
  notify: NotifyOwner
  enqueue: (name: string, data: object, opts?: SendOpts) => Promise<void>
  alert: Alert
  adminBaseUrl: string
  /** Optional: live CJ wallet read for the dashboard; absent → strip shows n/a. */
  getWalletBalance?: () => Promise<{ availableCents: number; frozenCents: number }>
}

const LOGIN_INVALID_COPY = 'This link is invalid or expired.'

export function adminRoutes(deps: AdminDeps): FastifyPluginAsync {
  return async (fastify) => {
    // Fastify ships parsers for application/json and text/plain ONLY. A real browser submitting
    // this plugin's <form method="post"> sends application/x-www-form-urlencoded, so without a
    // parser for it every POST here would 415 (FST_ERR_CTP_INVALID_MEDIA_TYPE) before the route
    // ever ran — the same Plan A regression actions.ts already hit once. Unlike actions.ts (whose
    // routes read nothing from the body), the login form really does need parsed fields, so this
    // parser does real work: Object.fromEntries(new URLSearchParams(...)). Scoped to this
    // plugin's encapsulation context only — actions.ts registers its own, separately.
    fastify.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'buffer' },
      (_req: unknown, body: unknown, done: (err: Error | null, body?: unknown) => void) => {
        try {
          const parsed = Object.fromEntries(new URLSearchParams((body as Buffer).toString()))
          done(null, parsed)
        } catch (err) {
          done(err as Error)
        }
      },
    )

    fastify.get('/admin/login', async (_request, reply) => {
      const body = layout(
        'Admin login',
        html`<form method="post" action="/admin/login"><button type="submit">Send me a login link</button></form>`,
      )
      return reply.code(200).type('text/html; charset=utf-8').send(body)
    })

    fastify.post('/admin/login', async (_request, reply) => {
      if ((await loginSendsLastHour(deps.db)) >= LOGIN_SENDS_HOURLY_CAP) {
        return reply.code(200).type('text/html; charset=utf-8').send(layout('Admin login', html`<p>Try again later.</p>`))
      }

      const token = await createLoginToken(deps.db)
      const delivered = await deps.notify({
        title: 'Doge Buddy admin login',
        body: 'Tap to log in (link valid 15 minutes).',
        actions: [{ label: 'Log in', url: `${deps.adminBaseUrl}/admin/login/consume?t=${token}` }],
      })

      if (!delivered) {
        // Alerting already happened inside notify() on the failure path — nothing more to do here
        // than tell the operator the link didn't go out.
        return reply.code(200).type('text/html; charset=utf-8').send(layout('Admin login', html`<p>Could not send the link — notifications unconfigured or failing.</p>`))
      }

      await deps.db.insert(auditLog).values({
        actor: 'system',
        action: 'admin.login_link_sent',
        entityType: 'admin',
      })
      return reply.code(200).type('text/html; charset=utf-8').send(layout('Admin login', html`<p>Link sent — check Telegram.</p>`))
    })

    fastify.get('/admin/login/consume', async (request, reply) => {
      const { t } = request.query as { t?: string }
      // NEVER mutates on GET: only a presence/shape check, so the confirm page can be rendered
      // (and re-rendered on refresh) without burning the token — only the POST below consumes it.
      if (t) {
        // `t` is attacker-influenced (straight off the query string): built into the action URL
        // via encodeURIComponent for URL-safety, then run through html``'s normal auto-escaping
        // like any other interpolation — no raw() here, so it stays inert even if the encoding
        // step were ever wrong. (Quoted attribute value per Task 1's discipline.)
        const action = `/admin/login/consume?t=${encodeURIComponent(t)}`
        const body = layout(
          'Confirm login',
          html`<form method="post" action="${action}"><button type="submit">Log in</button></form>`,
        )
        return reply.code(200).type('text/html; charset=utf-8').send(body)
      }
      return reply.code(200).type('text/html; charset=utf-8').send(layout('Admin login', html`<p>${LOGIN_INVALID_COPY}</p>`))
    })

    fastify.post('/admin/login/consume', async (request, reply) => {
      const { t } = request.query as { t?: string }
      const result = t ? await consumeLoginToken(deps.db, t) : null
      if (!result) {
        return reply.code(200).type('text/html; charset=utf-8').send(layout('Admin login', html`<p>${LOGIN_INVALID_COPY}</p>`))
      }

      await deps.db.insert(auditLog).values({
        actor: 'owner',
        action: 'admin.login',
        entityType: 'admin',
      })

      return reply
        .header('set-cookie', serializeSessionCookie(result.sessionToken))
        .code(303)
        .header('location', '/admin')
        .send()
    })

    await fastify.register(async (authed) => {
      authed.addHook('onRequest', async (request, reply) => {
        const cookie = parseCookieHeader(request.headers.cookie, SESSION_COOKIE)
        const valid = await validateSession(deps.db, cookie)
        if (!valid) {
          return reply.code(303).header('location', '/admin/login').send()
        }
      })

      // Task 6 replaces this stub with the real dashboard.
      authed.get('/admin', async (_request, reply) => {
        return reply.code(200).type('text/html; charset=utf-8').send(layout('Dashboard', html`<p>coming in Task 6</p>`))
      })

      async function lookupProposal(id: string) {
        const [row] = await deps.db.select().from(proposals).where(eq(proposals.id, id))
        return row
      }

      // Session-authed counterpart to actions.ts's public /a/:proposalId/approve|reject — same
      // guarded-UPDATE + lazy-expiry mechanics (StaleProposalStatusError means someone else, an
      // owner via the one-click link or a concurrent admin tab, already decided this row), but
      // reached via the cookie session instead of a bearer token, and with an optional
      // edit-then-approve payload override.
      for (const decision of ['approve', 'reject'] as const) {
        authed.post(`/admin/proposals/:id/${decision}`, async (request, reply) => {
          const { id } = request.params as { id: string }
          const row = await lookupProposal(id)

          // Lazy expiry, mirroring actions.ts's POST path exactly: a pending row past its
          // expiresAt flips to 'expired' the moment anyone actually acts on it, regardless of
          // which surface (link or admin) triggered the act. The flip itself is always
          // attributed to 'system' — the admin/'owner' context only applies to a real decision.
          if (row && row.status === 'pending' && !(row.expiresAt.getTime() > Date.now())) {
            try {
              await applyProposalTransition(deps.db, id, 'pending', 'expired')
              await deps.db.insert(auditLog).values({
                actor: 'system',
                action: 'proposal.expired',
                entityType: 'proposal',
                entityId: id,
                detail: { via: 'lazy-expiry' },
              })
            } catch (err) {
              if (!(err instanceof StaleProposalStatusError)) throw err
            }
            return reply
              .code(200)
              .type('text/html; charset=utf-8')
              .send(layout('Proposal', html`<p>Already handled or expired.</p>`))
          }

          if (!row || row.status !== 'pending') {
            return reply
              .code(200)
              .type('text/html; charset=utf-8')
              .send(layout('Proposal', html`<p>Already handled or expired.</p>`))
          }

          // Edit-then-approve: an optional `payload` form field carries JSON text (from a
          // textarea) that replaces the proposal's stored payload before applying. Only approve
          // honors it — reject has nothing to validate a replacement payload against.
          let patchedPayload: unknown
          if (decision === 'approve') {
            const body = (request.body ?? {}) as { payload?: string }
            if (body.payload) {
              let parsedJson: unknown
              try {
                parsedJson = JSON.parse(body.payload)
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                return reply
                  .code(400)
                  .type('text/html; charset=utf-8')
                  .send(layout('Proposal', html`<p>Invalid JSON: ${message}</p>`))
              }

              const schema = PAYLOAD_SCHEMAS[row.type]
              const result = schema.safeParse(parsedJson)
              if (!result.success) {
                const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
                return reply
                  .code(400)
                  .type('text/html; charset=utf-8')
                  .send(
                    layout(
                      'Proposal',
                      html`<p>Invalid payload:</p>
                        <ul>
                          ${issues.map((issue) => html`<li>${issue}</li>`)}
                        </ul>`,
                    ),
                  )
              }
              patchedPayload = result.data
            }
          }

          const status = decision === 'approve' ? 'approved' : 'rejected'
          try {
            await applyProposalTransition(deps.db, id, 'pending', status, {
              decidedBy: 'owner',
              decidedAt: new Date(),
              actionTokenHash: null,
              ...(patchedPayload ? { payload: patchedPayload } : {}),
            })
          } catch (err) {
            if (err instanceof StaleProposalStatusError) {
              return reply.code(200).type('text/html; charset=utf-8').send(layout('Proposal', html`<p>Already handled.</p>`))
            }
            throw err
          }

          await deps.db.insert(auditLog).values({
            actor: 'owner',
            action: decision === 'approve' ? 'proposal.approve' : 'proposal.reject',
            entityType: 'proposal',
            entityId: id,
            detail: { via: 'admin', edited: Boolean(patchedPayload) },
          })

          if (decision === 'approve') {
            await enqueueProposalApply(deps.enqueue, id)
          }

          return reply.code(303).header('location', `/admin/proposals/${id}`).send()
        })
      }

      // Placeholder so the whole authed scope is gated from day one, even for paths Tasks 4-8
      // haven't registered yet (e.g. /admin/settings) — an unauthenticated request to any
      // /admin/... path must redirect to login rather than 404 (which would leak which admin
      // routes exist). `.all()`, not `.get()`: a GET-only wildcard would let an unauthenticated
      // non-GET request (POST, PUT, ...) to an unregistered path fall through to Fastify's
      // default 404 without ever reaching the onRequest gate above — a method-shaped oracle for
      // which admin routes exist. Real routes registered later take priority: find-my-way
      // matches static segments before a trailing wildcard, for every method.
      authed.all('/admin/*', async (_request, reply) => {
        return reply.code(404).send()
      })
    })
  }
}
