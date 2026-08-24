import { formatCents, PROPOSAL_TYPES, type ProposalType } from '@doge-buddy/core'
import {
  agentRuns,
  auditLog,
  orders,
  proposals,
  proposalStatus,
  sourcingSignals,
  supplierOrders,
  supportTickets,
  type createDb,
} from '@doge-buddy/db'
import { and, desc, eq, lt, ne } from 'drizzle-orm'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { FULFILLMENT_RETRY_OPTS } from '../../fulfillment/run-place-order.ts'
import { applyTransition, IllegalTransitionError, StaleStatusError } from '../../fulfillment/transitions.ts'
import type { SendOpts } from '../../fulfillment/types.ts'
import type { NotifyOwner } from '../../notify/notify.ts'
import { enqueueProposalApply, PAYLOAD_SCHEMAS } from '../../proposals/submit.ts'
import { applyProposalTransition, StaleProposalStatusError } from '../../proposals/transitions.ts'
import { SETTINGS_DEFAULTS, type Settings, type SettingKey, type WorkflowMode } from '../../settings.ts'
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
import { loadHealthStrip, type HealthStrip } from './health.ts'
import { html, layout, raw, type RawHtml } from './html.ts'
import { RECOVERY_TARGETS, renderNeedsAttentionSection, renderOtherOrdersSection } from './render-orders.ts'
import { renderProposalDetail, renderProposalRow } from './render-proposal.ts'

const PROPOSAL_STATUSES = proposalStatus.enumValues

/**
 * Renders the dashboard's health strip: wallet balance (or 'n/a'), queue depth, last webhook
 * received, the three kill switches (ON/OFF so the state reads unambiguously at a glance), and
 * the pending-proposal count. Every field is a `HealthStrip` value already loaded by
 * `loadHealthStrip` — this function only formats and escapes (via html``) for display.
 */
function renderHealthStrip(h: HealthStrip): RawHtml {
  return html`<section id="health-strip">
    <p>Wallet: ${h.walletCents === null ? 'n/a' : formatCents(h.walletCents)}</p>
    <p>Queue depth: ${h.queueDepth}</p>
    <p>Last webhook: ${h.lastWebhookAt ? h.lastWebhookAt.toISOString() : 'never'}</p>
    <p>Killswitch: ${h.killswitch ? 'ON' : 'OFF'}</p>
    <p>Fulfillment enabled: ${h.fulfillmentEnabled ? 'ON' : 'OFF'}</p>
    <p>Paused for funds: ${h.pausedForFunds ? 'ON' : 'OFF'}</p>
    <p>Pending proposals: ${h.pendingProposals}</p>
  </section>`
}

type SettingKind = 'boolean' | 'mode' | 'number'

/**
 * Buckets a settings key by its runtime type, per settings.ts's own source-of-truth comment:
 * boolean defaults are actual booleans, mode keys are the ones ending '.mode' (string default
 * 'manual'), everything else is a cents/bps/days number.
 */
function settingKind(key: SettingKey): SettingKind {
  const def = SETTINGS_DEFAULTS[key]
  if (typeof def === 'boolean') return 'boolean'
  if (key.endsWith('.mode')) return 'mode'
  return 'number'
}

/**
 * Typed write-through to `Settings.set`, contained to this one helper per the task's TypeScript
 * note: the runtime kind is only known at request time (the POST body is untyped strings), so
 * `Settings.set`'s per-key generic can't be satisfied statically at the call site. Each branch
 * casts `.set` to a concrete, non-generic signature matching that branch's own value type,
 * rather than reaching for a blanket `any` — kept local so no other file has to reason about it.
 */
async function setSettingValue(
  settingsApi: Settings,
  key: SettingKey,
  kind: SettingKind,
  value: boolean | WorkflowMode | number,
): Promise<void> {
  switch (kind) {
    case 'boolean': {
      const setter = settingsApi.set as (k: SettingKey, v: boolean) => Promise<void>
      return setter(key, value as boolean)
    }
    case 'mode': {
      const setter = settingsApi.set as (k: SettingKey, v: WorkflowMode) => Promise<void>
      return setter(key, value as WorkflowMode)
    }
    case 'number': {
      const setter = settingsApi.set as (k: SettingKey, v: number) => Promise<void>
      return setter(key, value as number)
    }
  }
}

interface SettingRow {
  key: SettingKey
  kind: SettingKind
  value: boolean | WorkflowMode | number
}

/**
 * One <form> per setting: a hidden `key` plus the single runtime-typed control (checkbox / mode
 * select / number input), each posting to `/admin/settings`. Per-row forms (not one big form) is
 * deliberate — an HTML checkbox sends nothing when unchecked, so the only way to submit "flip
 * this boolean off" unambiguously is a form scoped to that one key.
 */
function renderSettingRow(row: SettingRow): RawHtml {
  const control =
    row.kind === 'boolean'
      ? html`<input type="checkbox" name="value"${raw(row.value ? ' checked' : '')}>`
      : row.kind === 'mode'
        ? html`<select name="value">
            <option value="manual"${raw(row.value === 'manual' ? ' selected' : '')}>manual</option>
            <option value="auto"${raw(row.value === 'auto' ? ' selected' : '')}>auto</option>
          </select>`
        : html`<input type="number" name="value" value="${row.value}">`

  return html`<form method="post" action="/admin/settings">
    <label>${row.key}</label>
    <input type="hidden" name="key" value="${row.key}">
    ${control}
    <button type="submit">Save</button>
  </form>`
}

function renderSettingsSection(rows: SettingRow[]): RawHtml {
  return html`<section id="settings">
    <h2>Settings</h2>
    ${rows.map(renderSettingRow)}
  </section>`
}

/** The manual-signal paste box (parent spec §admin): keyword + content, posting to /admin/signals. */
function renderSignalPasteBox(): RawHtml {
  return html`<section id="signal-paste">
    <h2>Paste a sourcing signal</h2>
    <form method="post" action="/admin/signals">
      <label>Keyword <input name="keyword"></label>
      <label>Content <textarea name="content" rows="8" cols="60"></textarea></label>
      <button type="submit">Save signal</button>
    </form>
  </section>`
}

interface RecentSignalRow {
  keyword: string | null
  fetchedAt: Date
  content: string
}

/**
 * Every row this route writes stores `snapshot: { content: string }` — but jsonb is untyped at
 * the DB layer, so this narrows defensively rather than trusting the shape blindly.
 */
function snapshotContent(snapshot: unknown): string {
  if (snapshot && typeof snapshot === 'object' && 'content' in snapshot) {
    const content = (snapshot as { content: unknown }).content
    if (typeof content === 'string') return content
  }
  return ''
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

/** Last 10 owner-pasted signals: keyword + fetchedAt + content, escaped and truncated to 200 chars. */
function renderRecentSignals(rows: RecentSignalRow[]): RawHtml {
  if (rows.length === 0) {
    return html`<section id="recent-signals">
      <h2>Recently pasted signals</h2>
      <p>None yet.</p>
    </section>`
  }
  return html`<section id="recent-signals">
    <h2>Recently pasted signals</h2>
    <table>
      <tbody>
        ${rows.map(
          (r) => html`<tr>
            <td>${r.keyword ?? ''}</td>
            <td>${r.fetchedAt.toISOString()}</td>
            <td>${truncate(r.content, 200)}</td>
          </tr>`,
        )}
      </tbody>
    </table>
  </section>`
}

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

      authed.get('/admin', async (_request, reply) => {
        return safeHandle('dashboard', reply, async () => {
          const health = await loadHealthStrip(deps)
          return reply.code(200).type('text/html; charset=utf-8').send(layout('Dashboard', renderHealthStrip(health)))
        })
      })

      // Tickets and runs are Phase 5/6 features (agent-run support workflow, agent execution
      // history) — this task only wires the pages' read side against the tables schema.ts
      // already defines, so they render a real table the moment those phases start writing rows,
      // and a plain "not yet" line until then.
      authed.get('/admin/tickets', async (_request, reply) => {
        return safeHandle('tickets', reply, async () => {
          const rows = await deps.db
            .select({ id: supportTickets.id, status: supportTickets.status, createdAt: supportTickets.createdAt })
            .from(supportTickets)
            .orderBy(desc(supportTickets.createdAt))
            .limit(100)

          const body =
            rows.length === 0
              ? html`<p>No tickets yet — Phase 6.</p>`
              : html`<table>
                  <tbody>
                    ${rows.map(
                      (t) => html`<tr>
                        <td>${t.id}</td>
                        <td>${t.status}</td>
                        <td>${t.createdAt.toISOString()}</td>
                      </tr>`,
                    )}
                  </tbody>
                </table>`

          return reply.code(200).type('text/html; charset=utf-8').send(layout('Tickets', body))
        })
      })

      authed.get('/admin/runs', async (_request, reply) => {
        return safeHandle('runs', reply, async () => {
          const rows = await deps.db
            .select({ id: agentRuns.id, workflow: agentRuns.workflow, status: agentRuns.status, createdAt: agentRuns.createdAt })
            .from(agentRuns)
            .orderBy(desc(agentRuns.createdAt))
            .limit(100)

          const body =
            rows.length === 0
              ? html`<p>No agent runs yet — Phase 5.</p>`
              : html`<table>
                  <tbody>
                    ${rows.map(
                      (r) => html`<tr>
                        <td>${r.id}</td>
                        <td>${r.workflow}</td>
                        <td>${r.status}</td>
                        <td>${r.createdAt.toISOString()}</td>
                      </tr>`,
                    )}
                  </tbody>
                </table>`

          return reply.code(200).type('text/html; charset=utf-8').send(layout('Runs', body))
        })
      })

      async function lookupProposal(id: string) {
        const [row] = await deps.db.select().from(proposals).where(eq(proposals.id, id))
        return row
      }

      /**
       * Bulk-flips lazily-expired pending rows before a proposals page renders them — same
       * guarded UPDATE shape as proposal-expire-sweep.ts's periodic job (and+eq+lt, returning
       * ids, one audit row per id), but tagged `via: 'admin-load'` since the trigger here is an
       * admin page view rather than the sweep job, and (unlike the sweep) optionally scoped to a
       * single row: the list route wants every such row flipped before it reads the page, the
       * detail route only wants the one row it's about to render.
       */
      async function sweepExpiredOnLoad(scopeId?: string): Promise<void> {
        const conditions = [eq(proposals.status, 'pending'), lt(proposals.expiresAt, new Date())]
        if (scopeId) conditions.push(eq(proposals.id, scopeId))

        const expiredIds = await deps.db
          .update(proposals)
          .set({ status: 'expired' })
          .where(and(...conditions))
          .returning({ id: proposals.id })

        if (expiredIds.length > 0) {
          await deps.db.insert(auditLog).values(
            expiredIds.map((row) => ({
              actor: 'system',
              action: 'proposal.expired',
              entityType: 'proposal',
              entityId: row.id,
              detail: { via: 'admin-load' },
            })),
          )
        }
      }

      /**
       * Catch-all wrapper for authed admin page/action handlers — the same class of defense
       * actions.ts's `safeRender` provides for the public /a/ links: any unexpected error thrown
       * inside `work` (most concretely a malformed `:id` reaching a `WHERE id = $1` on a uuid
       * column, which Postgres rejects with "invalid input syntax for type uuid" — Fastify's
       * default error handler would otherwise turn that into a 500 whose body echoes the raw
       * query, column list, and the attacker-controlled id right back at the client) is alerted
       * and degraded to a generic, information-free 200 page instead of leaking internals.
       * Session-authed here (unlike actions.ts's public routes) so this is defense in depth
       * rather than an outsider-reachable leak, but the Plan A precedent is to never skip it.
       * Reusable: later routes in this same authed scope (Tasks 5-8's proposal/order/ticket
       * pages) should wrap their handlers with this too, not reimplement it.
       */
      async function safeHandle(
        entityId: string,
        reply: FastifyReply,
        work: () => Promise<FastifyReply>,
      ): Promise<FastifyReply> {
        try {
          return await work()
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          await deps.alert('warning', 'admin_route_error', { proposalId: entityId, error: message }).catch(() => {})
          return reply.code(200).type('text/html; charset=utf-8').send(layout('Proposal', html`<p>Something went wrong.</p>`))
        }
      }

      // Queue + detail pages (Task 5). Both run the lazy-expiry sweep above for exactly what
      // they're about to show, then read fresh so a just-flipped row never renders stale.
      authed.get('/admin/proposals', async (request, reply) => {
        return safeHandle('proposals-list', reply, async () => {
          await sweepExpiredOnLoad()

          const { type, status } = request.query as { type?: string; status?: string }
          const conditions = []
          if (type && (PROPOSAL_TYPES as readonly string[]).includes(type)) {
            conditions.push(eq(proposals.type, type as ProposalType))
          }
          if (status && (PROPOSAL_STATUSES as readonly string[]).includes(status)) {
            conditions.push(eq(proposals.status, status as (typeof PROPOSAL_STATUSES)[number]))
          }

          const rows = await deps.db
            .select({
              id: proposals.id,
              type: proposals.type,
              status: proposals.status,
              summary: proposals.summary,
              createdAt: proposals.createdAt,
              expiresAt: proposals.expiresAt,
            })
            .from(proposals)
            .where(conditions.length > 0 ? and(...conditions) : undefined)
            .orderBy(desc(proposals.createdAt))
            .limit(100)

          const body = layout(
            'Proposals',
            html`<table>
              <tbody>
                ${rows.map(renderProposalRow)}
              </tbody>
            </table>`,
          )
          return reply.code(200).type('text/html; charset=utf-8').send(body)
        })
      })

      authed.get('/admin/proposals/:id', async (request, reply) => {
        const { id } = request.params as { id: string }
        return safeHandle(id, reply, async () => {
          await sweepExpiredOnLoad(id)

          const row = await lookupProposal(id)
          if (!row) {
            return reply.code(200).type('text/html; charset=utf-8').send(layout('Proposal', html`<p>Not found.</p>`))
          }

          return reply.code(200).type('text/html; charset=utf-8').send(layout('Proposal', renderProposalDetail(row)))
        })
      })

      // Session-authed counterpart to actions.ts's public /a/:proposalId/approve|reject — same
      // guarded-UPDATE + lazy-expiry mechanics (StaleProposalStatusError means someone else, an
      // owner via the one-click link or a concurrent admin tab, already decided this row), but
      // reached via the cookie session instead of a bearer token, and with an optional
      // edit-then-approve payload override.
      for (const decision of ['approve', 'reject'] as const) {
        authed.post(`/admin/proposals/:id/${decision}`, async (request, reply) => {
          const { id } = request.params as { id: string }
          return safeHandle(id, reply, async () => {
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
        })
      }

      // Retires the operations runbook's raw SQL: the full orders ⋈ supplier_orders view, with
      // needs_attention rows pinned on top (their lastError + a recovery form each) and every
      // other row below, both capped at 100 and ordered by the supplier_orders row's own
      // createdAt desc. `pinnedRows` is passed to `renderNeedsAttentionSection` as an explicit
      // list rather than that function reading the DB itself — see that function's doc comment
      // for why (Phase 7's canary-hold seam).
      authed.get('/admin/orders', async (_request, reply) => {
        return safeHandle('orders-list', reply, async () => {
          const columns = {
            id: supplierOrders.id,
            shopifyOrderGid: orders.shopifyOrderGid,
            shopifyOrderNumber: orders.shopifyOrderNumber,
            customerName: orders.customerName,
            supplier: supplierOrders.supplier,
            status: supplierOrders.status,
            lastError: supplierOrders.lastError,
            createdAt: supplierOrders.createdAt,
          }

          const pinnedRows = await deps.db
            .select(columns)
            .from(supplierOrders)
            .innerJoin(orders, eq(supplierOrders.orderId, orders.id))
            .where(eq(supplierOrders.status, 'needs_attention'))
            .orderBy(desc(supplierOrders.createdAt))
            .limit(100)

          const otherRows = await deps.db
            .select(columns)
            .from(supplierOrders)
            .innerJoin(orders, eq(supplierOrders.orderId, orders.id))
            .where(ne(supplierOrders.status, 'needs_attention'))
            .orderBy(desc(supplierOrders.createdAt))
            .limit(100)

          const body = layout(
            'Orders',
            html`${renderNeedsAttentionSection(pinnedRows)}${renderOtherOrdersSection(otherRows)}`,
          )
          return reply.code(200).type('text/html; charset=utf-8').send(body)
        })
      })

      const NOT_RECOVERABLE_COPY = 'Row was not recoverable (state changed?)'

      /**
       * Joins to the order's `shopifyOrderGid` and re-sends the place-order job, for the given
       * `supplier_orders` row. Returns `true` on success. On ANY failure — the join coming back
       * empty (should be impossible given the FK, but treated as a send failure rather than a
       * silent no-op) or `enqueue` itself throwing — alerts `recovery_enqueue_failed` (best-effort:
       * `.catch(() => {})`, matching every other alert call site in this file) and returns `false`
       * so the caller can render the explicit retry page instead of a false-success 303. This is
       * the fix for the review finding: a `supplier_orders` row could otherwise commit to
       * pending/confirmed while the mandatory re-send silently never happened, leaving the order
       * "sits inert until overdue" with no operator-visible signal.
       */
      async function reSendPlaceOrder(rowId: string, target: string): Promise<boolean> {
        try {
          const [joined] = await deps.db
            .select({ shopifyOrderGid: orders.shopifyOrderGid })
            .from(supplierOrders)
            .innerJoin(orders, eq(supplierOrders.orderId, orders.id))
            .where(eq(supplierOrders.id, rowId))
          if (!joined) {
            throw new Error(`orders join missing for supplier_orders row ${rowId}`)
          }
          await deps.enqueue(
            'fulfillment.place-order',
            { orderGid: joined.shopifyOrderGid },
            { singletonKey: joined.shopifyOrderGid, ...FULFILLMENT_RETRY_OPTS },
          )
          return true
        } catch {
          await deps.alert('critical', 'recovery_enqueue_failed', { supplierOrderRowId: rowId, target }).catch(() => {})
          return false
        }
      }

      function reSendFailedPage(reply: FastifyReply, target: string): FastifyReply {
        return reply
          .code(200)
          .type('text/html; charset=utf-8')
          .send(
            layout(
              'Orders',
              html`<p>Recovered to ${target}, but the re-send FAILED — submit this form again to retry the re-send.</p>`,
            ),
          )
      }

      // The runbook's mandatory recovery action, as a POST instead of raw SQL: guarded transition
      // needs_attention -> {pending, confirmed, cancelled} via the sole legal writer
      // (applyTransition), an audit row on success, and — for every target except cancelled — an
      // ALWAYS re-send of the place-order job (the runbook step operators used to forget) with the
      // exact same singletonKey + retry shape the pipeline itself uses, so a duplicate recovery
      // click collapses via pg-boss's own singleton dedup rather than double-placing an order.
      authed.post('/admin/orders/:id/recover', async (request, reply) => {
        const { id } = request.params as { id: string }
        return safeHandle(id, reply, async () => {
          const { target } = (request.body ?? {}) as { target?: string }
          if (!target || !(RECOVERY_TARGETS as readonly string[]).includes(target)) {
            return reply.code(400).type('text/html; charset=utf-8').send(layout('Orders', html`<p>Invalid target.</p>`))
          }
          const recoveryTarget = target as (typeof RECOVERY_TARGETS)[number]

          // Idempotent re-send path. An operator who just saw `reSendFailedPage` naturally
          // resubmits the SAME form — by then the transition already committed (only the enqueue
          // failed), so a second `applyTransition(needs_attention -> target)` would 0-row-match
          // and throw StaleStatusError, rendering the generic not-recoverable page: indistinguishable
          // from a stale double-click on an already-handled row. Detecting "already AT target"
          // up front and re-sending directly (no transition attempted) turns that resubmit into a
          // real retry. Repeating it is safe: pg-boss's `singletonKey` dedupes an already-active
          // place-order job for this orderGid, and `executePlaceOrder`'s resume switch
          // (run-place-order.ts) is idempotent per `supplier_orders.status` — re-entering it via a
          // duplicate send just resumes from wherever the row currently is, never double-places.
          // Only pending/confirmed are eligible: 'cancelled' never re-sends (by design, same as
          // the fresh-recovery path below), and any OTHER current status (e.g. already 'paid')
          // falls through to the normal transition attempt, which correctly renders
          // not-recoverable since the row is no longer 'needs_attention'.
          const [current] = await deps.db.select({ status: supplierOrders.status }).from(supplierOrders).where(eq(supplierOrders.id, id))
          if (current && current.status === recoveryTarget && (recoveryTarget === 'pending' || recoveryTarget === 'confirmed')) {
            const sent = await reSendPlaceOrder(id, recoveryTarget)
            if (!sent) {
              return reSendFailedPage(reply, recoveryTarget)
            }

            await deps.db.insert(auditLog).values({
              actor: 'owner',
              action: 'supplier_order.resent',
              entityType: 'supplier_order',
              entityId: id,
              detail: { status: recoveryTarget },
            })

            return reply.code(303).header('location', '/admin/orders').send()
          }

          try {
            await applyTransition(deps.db, id, 'needs_attention', recoveryTarget)
          } catch (err) {
            if (err instanceof IllegalTransitionError || err instanceof StaleStatusError) {
              return reply.code(200).type('text/html; charset=utf-8').send(layout('Orders', html`<p>${NOT_RECOVERABLE_COPY}</p>`))
            }
            throw err
          }

          await deps.db.insert(auditLog).values({
            actor: 'owner',
            action: 'supplier_order.recovered',
            entityType: 'supplier_order',
            entityId: id,
            detail: { from: 'needs_attention', to: recoveryTarget },
          })

          if (recoveryTarget !== 'cancelled') {
            const sent = await reSendPlaceOrder(id, recoveryTarget)
            if (!sent) {
              return reSendFailedPage(reply, recoveryTarget)
            }
          }

          return reply.code(303).header('location', '/admin/orders').send()
        })
      })

      // Settings editor (SETTINGS_DEFAULTS catalog, typed per key) + the manual-signal paste box
      // (parent §admin) share this page: both write through owner-attributed audit rows, and the
      // paste box's own POST target renders back here.
      authed.get('/admin/settings', async (_request, reply) => {
        return safeHandle('settings', reply, async () => {
          const keys = Object.keys(SETTINGS_DEFAULTS) as SettingKey[]
          const rows: SettingRow[] = await Promise.all(
            keys.map(async (key) => ({ key, kind: settingKind(key), value: await deps.settings.get(key) })),
          )

          const signalRows = await deps.db
            .select({ keyword: sourcingSignals.keyword, snapshot: sourcingSignals.snapshot, fetchedAt: sourcingSignals.fetchedAt })
            .from(sourcingSignals)
            .where(eq(sourcingSignals.source, 'owner_manual'))
            .orderBy(desc(sourcingSignals.fetchedAt))
            .limit(10)

          const recent: RecentSignalRow[] = signalRows.map((r) => ({
            keyword: r.keyword,
            fetchedAt: r.fetchedAt,
            content: snapshotContent(r.snapshot),
          }))

          const body = layout(
            'Settings',
            html`${renderSettingsSection(rows)}${renderSignalPasteBox()}${renderRecentSignals(recent)}`,
          )
          return reply.code(200).type('text/html; charset=utf-8').send(body)
        })
      })

      authed.post('/admin/settings', async (request, reply) => {
        return safeHandle('settings', reply, async () => {
          const body = (request.body ?? {}) as { key?: string; value?: string }
          const rawKey = body.key
          if (!rawKey || !Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, rawKey)) {
            return reply.code(400).type('text/html; charset=utf-8').send(layout('Settings', html`<p>Unknown setting.</p>`))
          }
          const key = rawKey as SettingKey
          const kind = settingKind(key)

          let coerced: boolean | WorkflowMode | number
          if (kind === 'boolean') {
            // HTML checkboxes send 'on' when checked and NOTHING when unchecked — so 'on' -> true,
            // any other value (including absent) -> false.
            coerced = body.value === 'on'
          } else if (kind === 'mode') {
            if (body.value !== 'manual' && body.value !== 'auto') {
              return reply.code(400).type('text/html; charset=utf-8').send(layout('Settings', html`<p>Invalid mode.</p>`))
            }
            coerced = body.value
          } else {
            const n = Number(body.value)
            if (body.value === undefined || body.value === '' || !Number.isSafeInteger(n) || n < 0) {
              return reply.code(400).type('text/html; charset=utf-8').send(layout('Settings', html`<p>Invalid number.</p>`))
            }
            coerced = n
          }

          const from = await deps.settings.get(key)
          await setSettingValue(deps.settings, key, kind, coerced)

          // No entityType/entityId here (unlike signal.pasted below) — a settings key isn't a
          // row with its own id; `detail.key` is the identifying field for this action.
          await deps.db.insert(auditLog).values({
            actor: 'owner',
            action: 'setting.updated',
            detail: { key, from, to: coerced },
          })

          return reply.code(303).header('location', '/admin/settings').send()
        })
      })

      authed.post('/admin/signals', async (request, reply) => {
        return safeHandle('signals', reply, async () => {
          const body = (request.body ?? {}) as { content?: string; keyword?: string }
          const content = body.content ?? ''
          if (content.trim().length === 0) {
            return reply.code(400).type('text/html; charset=utf-8').send(layout('Settings', html`<p>Paste some content first.</p>`))
          }

          const [inserted] = await deps.db
            .insert(sourcingSignals)
            .values({
              source: 'owner_manual',
              keyword: body.keyword || null,
              snapshot: { content },
            })
            .returning({ id: sourcingSignals.id })

          await deps.db.insert(auditLog).values({
            actor: 'owner',
            action: 'signal.pasted',
            entityType: 'signal',
            entityId: inserted!.id,
          })

          return reply.code(303).header('location', '/admin/settings').send()
        })
      })

      // Placeholder so the whole authed scope is gated from day one, even for any path this
      // plan's tasks never register — an unauthenticated request to any
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
