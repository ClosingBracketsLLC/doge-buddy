import { formatCents } from '@doge-buddy/core'
import { SUPPORT_AGENT_MAX_RUNS_PER_DAY } from '../../jobs/support-agent-run.ts'
import type { SettingKey } from '../../settings.ts'
import type { HealthStrip } from './health.ts'
import { chip, html, kv, raw, relativeTime, type RawHtml } from './html.ts'

/**
 * Confirm-before-danger copy for boolean settings, shared verbatim between the two surfaces that
 * render a toggle for these keys: the dashboard's own switch cards (this file) and the generic
 * /admin/settings catalog row (routes.ts's `renderSettingRow`). Rule: confirm when the NEW state
 * is the dangerous one — kill switch turning ON (stops every workflow), fulfillment turning OFF
 * (supplier orders silently stop being placed).
 */
export const DANGEROUS_SETTING_CONFIRMS: Partial<Record<SettingKey, { whenTurningOn?: string; whenTurningOff?: string }>> = {
  'killswitch.global': { whenTurningOn: 'Turn the global kill switch ON? Every workflow stops.' },
  'workflow.fulfillment.enabled': { whenTurningOff: 'Turn fulfillment OFF? New orders will not be placed with the supplier.' },
}

/**
 * Renders the dashboard's health strip: wallet balance (or 'n/a'), queue depth, last webhook
 * received, the three kill switches (ON/OFF so the state reads unambiguously at a glance), the
 * pending-proposal count, and (Task 11 scoring) the newest `product_scores.score_date` plus how
 * many products were scored that day ('never'/0 before the scoring job has ever run). Every
 * field is a `HealthStrip` value already loaded by `loadHealthStrip` — this function only formats
 * and escapes (via html``) for display.
 */
export function renderHealthStrip(h: HealthStrip): RawHtml {
  // Visible below-threshold call-out, distinct from the plain "Wallet: $x.xx" line above it: an
  // operator scanning the strip should not have to do the < comparison against the settings page
  // themselves to notice the wallet is running low.
  const belowThreshold = h.walletCents !== null && h.walletCents < h.walletAlertThresholdCents
  return html`<section id="health-strip">
    <p>Wallet: ${h.walletCents === null ? 'n/a' : formatCents(h.walletCents)}</p>
    ${belowThreshold
      ? html`<p id="wallet-alert">wallet: ${formatCents(h.walletCents!)} (BELOW ALERT THRESHOLD ${formatCents(h.walletAlertThresholdCents)})</p>`
      : html``}
    <p>Queue depth: ${h.queueDepth}</p>
    <p>Last webhook: ${h.lastWebhookAt ? h.lastWebhookAt.toISOString() : 'never'}</p>
    <p>Killswitch: ${h.killswitch ? 'ON' : 'OFF'}</p>
    <p>Fulfillment enabled: ${h.fulfillmentEnabled ? 'ON' : 'OFF'}</p>
    <p>Paused for funds: ${h.pausedForFunds ? 'ON' : 'OFF'}</p>
    <p>Pending proposals: ${h.pendingProposals}</p>
    <p>support poll: last ok ${h.supportPollLastSuccessAt ? h.supportPollLastSuccessAt.toISOString() : 'never'} (${h.supportPollConsecutiveFailures} consecutive failures)</p>
    <p>support agent: ${h.supportAgentRunsToday} runs today / ${SUPPORT_AGENT_MAX_RUNS_PER_DAY}</p>
    <p>support agent last run: ${h.supportAgentLastRun ? `${h.supportAgentLastRun.status} at ${h.supportAgentLastRun.startedAt.toISOString()}` : 'none'}</p>
    <p>scoring: last run ${h.scoringLastRunDate ?? 'never'}, ${h.scoringProductsScored} products scored</p>
  </section>`
}

const CATALOG_TARGET = 40 // build-week goal (docs/OWNER-CHECKLIST.md runway B14)

function statCard(label: string, value: number, href: string, opts: { zeroText?: string } = {}): RawHtml {
  const tone = value > 0 ? 'bad' : 'ok'
  return html`<a class="card" href="${raw(href)}"><div class="label">${label}</div><div class="stat ${raw(tone)}">${value}</div><div class="empty">${value > 0 ? 'tap to review' : (opts.zeroText ?? 'all clear')}</div></a>`
}

function walletCard(h: HealthStrip): RawHtml {
  if (h.walletCents === null) {
    return html`<div class="card"><div class="label">CJ wallet</div><div class="stat">n/a</div><div class="empty">wallet read unavailable</div></div>`
  }
  // Review ruling (3): a threshold of 0 means alerting is OFF, not "alert the instant the wallet
  // has anything less than a threshold of $0.00" — the old ratio math (guarded to 1 when the
  // threshold is 0) fell into the `< 2` branch and rendered a 'warn' tone + an "alert threshold
  // $0.00" footer, which lied about there being an active alert line.
  const noThreshold = h.walletAlertThresholdCents === 0
  const ratio = h.walletAlertThresholdCents > 0 ? h.walletCents / h.walletAlertThresholdCents : 1
  const tone = noThreshold ? 'ok' : ratio < 1 ? 'bad' : ratio < 2 ? 'warn' : 'ok'
  const pct = Math.max(0, Math.min(100, Math.round((ratio / 2) * 100)))
  const footer = noThreshold ? 'no alert threshold' : `alert threshold ${formatCents(h.walletAlertThresholdCents)}`
  return html`<div class="card"><div class="label">CJ wallet</div><div class="stat ${raw(tone)}">${formatCents(h.walletCents)}</div>
    <div class="bar ${raw(tone === 'ok' ? '' : tone)}"><i style="width:${raw(String(pct))}%"></i></div>
    <div class="empty">${footer}${h.pausedForFunds ? html` · ${chip('ON')} paused for funds` : html``}</div></div>`
}

function toggleCard(
  label: string,
  key: string,
  on: boolean,
  confirm?: { whenTurningOn?: string; whenTurningOff?: string },
): RawHtml {
  const confirmMsg = confirm ? (!on ? confirm.whenTurningOn : confirm.whenTurningOff) : undefined
  const confirmAttr = confirmMsg ? html` data-confirm="${confirmMsg}"` : html``
  return html`<div class="card"><form method="post" action="/admin/settings" data-autosubmit${confirmAttr}>
    <input type="hidden" name="key" value="${key}"><input type="hidden" name="returnTo" value="/admin">
    <div class="toggle"><label for="sw-${raw(key.replaceAll('.', '-'))}">${label}</label>
      <input type="checkbox" id="sw-${raw(key.replaceAll('.', '-'))}" name="value" value="on"${raw(on ? ' checked' : '')}></div>
    <button type="submit" class="js-hide">Save</button></form></div>`
}

function modeCard(label: string, key: string, current: 'manual' | 'auto'): RawHtml {
  const seg = (mode: 'manual' | 'auto') =>
    html`<button type="submit" name="value" value="${mode}" aria-pressed="${raw(String(current === mode))}">${mode}</button>`
  return html`<div class="card"><form method="post" action="/admin/settings">
    <input type="hidden" name="key" value="${key}"><input type="hidden" name="returnTo" value="/admin">
    <div class="toggle"><label>${label}</label><span class="seg">${seg('manual')}${seg('auto')}</span></div></form></div>`
}

export function renderDashboard(h: HealthStrip, now: Date = new Date()): RawHtml {
  const runLine = (run: { status: string; startedAt: Date } | null) => (run ? html`${chip(run.status)} ${relativeTime(run.startedAt, now)}` : html`never`)
  const catalogPct = Math.min(100, Math.round((h.activeProducts / CATALOG_TARGET) * 100))
  return html`
    <h2>Needs you</h2>
    <div class="grid">
      ${statCard('Pending proposals', h.pendingProposals, '/admin/proposals?status=pending')}
      ${statCard('Escalated tickets', h.escalatedTickets, '/admin/tickets?status=escalated')}
      ${statCard('Orders needing attention', h.ordersNeedsAttention, '/admin/orders')}
    </div>
    <h2>Money</h2>
    <div class="grid">${walletCard(h)}</div>
    <h2>Switches</h2>
    <div class="grid">
      ${toggleCard('Global kill switch', 'killswitch.global', h.killswitch, DANGEROUS_SETTING_CONFIRMS['killswitch.global'])}
      ${toggleCard('Fulfillment', 'workflow.fulfillment.enabled', h.fulfillmentEnabled, DANGEROUS_SETTING_CONFIRMS['workflow.fulfillment.enabled'])}
      ${modeCard('Sourcing', 'workflow.sourcing.mode', h.modes.sourcing)}
      ${modeCard('Support replies', 'workflow.support_reply.mode', h.modes.supportReply)}
      ${modeCard('Refunds', 'workflow.refund.mode', h.modes.refund)}
      ${modeCard('Deprecation', 'workflow.deprecation.mode', h.modes.deprecation)}
    </div>
    <h2>Agents &amp; jobs</h2>
    <div class="card">
      ${kv('Sourcing last run', runLine(h.sourcingLastRun), h.sourcingLastRun?.startedAt)}
      ${kv('Support agent today', html`${h.supportAgentRunsToday} / ${SUPPORT_AGENT_MAX_RUNS_PER_DAY}`)}
      ${kv('Support agent last run', runLine(h.supportAgentLastRun), h.supportAgentLastRun?.startedAt)}
      ${kv('Support poll', h.supportPollConsecutiveFailures > 0 ? html`${chip('failed')} ${h.supportPollConsecutiveFailures} failures` : html`${chip(h.supportPollLastSuccessAt ? 'ok' : 'never')} ${relativeTime(h.supportPollLastSuccessAt, now)}`, h.supportPollLastSuccessAt)}
      ${kv('Scoring', h.scoringLastRunDate ? html`${h.scoringLastRunDate} · ${h.scoringProductsScored} scored` : 'never')}
      ${kv('Inventory sync', html`${relativeTime(h.inventorySyncLastAt, now)}${h.inventorySyncDegraded ? html` ${chip('DEGRADED')}` : html``}`, h.inventorySyncLastAt)}
      ${kv('Queue depth', String(h.queueDepth))}
      ${kv('Last webhook', relativeTime(h.lastWebhookAt, now), h.lastWebhookAt)}
    </div>
    <h2>Catalog</h2>
    <div class="grid">
      <div class="card"><div class="label">Active products</div><div class="stat">${h.activeProducts}</div>
        ${h.activeProducts < CATALOG_TARGET ? html`<div class="bar"><i style="width:${raw(String(catalogPct))}%"></i></div><div class="empty">${h.activeProducts} of ${CATALOG_TARGET} build-week target</div>` : html`<div class="empty">target reached</div>`}</div>
      <div class="card"><div class="label">Tracked variants</div><div class="stat">${h.trackedVariants}</div></div>
      <div class="card"><div class="label">Latest listing</div>
        ${h.latestListing ? html`<div>${h.latestListing.handle ? html`<a href="https://dogebuddy.com/products/${h.latestListing.handle}">${h.latestListing.title}</a>` : h.latestListing.title}</div><div class="empty">${relativeTime(h.latestListing.createdAt, now)}</div>` : html`<div class="empty">none yet</div>`}</div>
    </div>
    <details class="card"><summary>System status (text)</summary>${renderHealthStrip(h)}</details>`
}
