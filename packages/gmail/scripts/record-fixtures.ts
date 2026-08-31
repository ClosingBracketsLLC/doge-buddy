import { writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createGmailAuth } from '../src/auth.ts'
import { createGmailClient } from '../src/client.ts'

/**
 * GMAIL_CONTRACT=1 fixture re-recorder.
 *
 * Records real Gmail API request/response pairs against the live support mailbox and rewrites
 * packages/gmail/test/fixtures/*.json in place, in the exact
 * `{ request: { method, path, query }, response: { status, body } }` shape the contract suite
 * (packages/gmail/test/client.test.ts) already reads — the output is a drop-in replacement, not a
 * new format.
 *
 * Usage (from repo root; `set -a` sourcing is deliberate — the PEM in GMAIL_SERVICE_ACCOUNT_KEY is
 * double-quoted with literal `\n` sequences, and `env $(grep … | xargs)` would strip the quotes AND
 * turn every `\n` into `n`, corrupting the key):
 *   set -a && . apps/ops/.env && set +a && GMAIL_CONTRACT=1 \
 *     pnpm --filter @doge-buddy/gmail exec tsx scripts/record-fixtures.ts
 *
 * Required env vars (read directly from process.env — apps/ops's loadDotEnv helper isn't
 * reachable from this package, hence sourcing apps/ops/.env above): GMAIL_SERVICE_ACCOUNT_EMAIL,
 * GMAIL_SERVICE_ACCOUNT_KEY, GMAIL_IMPERSONATE, SUPPORT_ADDRESS. GMAIL_SERVICE_ACCOUNT_KEY's
 * literal `\n` sequences are unescaped the same way apps/ops/src/config.ts does for the live
 * server.
 *
 * Before running: the support inbox needs at least one real received message (any modern client
 * sends multipart/alternative, which is the nested-multipart case, and Gmail stamps every inbound
 * with Authentication-Results). The single-part text/plain case is taken from the inbox when one
 * exists, otherwise from `in:sent` — OUR OWN replies are plain single-part text (buildReplyRaw),
 * and no mainstream mail client produces that shape any more, so a sent copy is the realistic
 * source (learned on the first live run, 2026-08-30: 17 inbox messages, zero single-part text).
 *
 * With GMAIL_CONTRACT unset (or not '1'), this prints usage and exits 0 without touching the
 * network or the filesystem — safe to invoke by accident, and this is the only path exercised in
 * environments without credentials (including this one).
 *
 * Recorded endpoints: getProfile; listHistory twice — once from the profile's CURRENT historyId
 * (always the empty page: real Gmail omits the `history` key entirely, `history-empty.json`) and
 * once from the newest message historyId that yields at least one `messagesAdded` record within a
 * single page (`history-page1.json`; no pageToken follow-up — pagination stays on the hand-authored
 * `history-paged-{1,2}.json` pair because a real mailbox can't be made to paginate on demand);
 * listMessages; getThread (preferring a message whose threadId differs from its id, so the recorded
 * thread has more than one message); getMessage (format=full for one nested-multipart inbound, one
 * single-part text message, and — opportunistically, only when one is in the inbox — one
 * attachment-only message with no text leaf at all, e.g. Google's daily DMARC zip report, which is
 * real traffic the poll ingests; format=metadata for the single-part message AND for a message
 * carrying an Authentication-Results header — the money gate's input, FR9); listLabels. See
 * `RECORDED_FIXTURE_NAMES` for the exact file list. Everything else in the fixtures directory
 * (404/error fixtures, label-create, send-reply, history-paged-*, message-metadata-proposal-marker)
 * is hand-authored and left untouched — the X-DogeBuddy-Proposal marker only rides OUR OWN sends,
 * which the recorder never performs (a sent copy chosen for the single-part case does carry a real
 * marker, which is a bonus round-trip check, not the marker fixture's replacement).
 *
 * NEVER records:
 *   - sendReply — no unsolicited sends against a real mailbox.
 *   - the JWT/token-exchange path — createGmailAuth below is given no fetchFn override, so its
 *     token fetch uses the plain global fetch, never the recording wrapper. That path is unit-
 *     tested with a throwaway key in packages/gmail/test/auth.test.ts and must never touch a real
 *     fixture file (6A scrubbing contract).
 *
 * Scrubbing: fixture files never carry a request-headers field at all (the shape above only ever
 * has `request: { method, path, query }`), so the Authorization bearer token is excluded
 * structurally, by construction, not by best-effort redaction. assertScrubbed() below is still run
 * on every captured fixture right before any file is written, as defense-in-depth against the same
 * binding contract: no fixture file may ever contain the strings "Bearer " or "PRIVATE KEY".
 */

interface CapturedFixture {
  request: { method: string; path: string; query?: Record<string, string | string[]> }
  response: { status: number; body: unknown }
}

/**
 * The fixture files a live `GMAIL_CONTRACT=1` run (re)writes, as an explicit exported list so a unit
 * test can assert the money-gate inputs are among them (FR9). `message-metadata-auth-results.json`
 * is the money gate's own input: the refund sender-auth check parses the topmost
 * `Authentication-Results` header, and before this it was backed ONLY by a hand-authored fixture, so
 * a live re-record could never validate `authenticationResults` normalization against real Gmail.
 *
 * NOT in this list (deliberate): `message-metadata-proposal-marker.json`. The `X-DogeBuddy-Proposal`
 * marker only appears on OUR OWN sends, which the recorder never performs (no unsolicited sends
 * against a real mailbox) — its real-Gmail verification is the OWNER-CHECKLIST Tier-2 metadata
 * assertion, not this recorder. The remaining hand-authored fixtures (404/error, label-create,
 * send-reply) are also intentionally absent — the recorder leaves them untouched.
 */
export const RECORDED_FIXTURE_NAMES = [
  'profile.json',
  'history-empty.json',
  'history-page1.json',
  'messages-list.json',
  'thread-get.json',
  'message-full-nested.json',
  'message-full-singlepart.json',
  // Written only when the inbox holds an attachment-only message (no text leaf); otherwise the
  // previous recording is left in place.
  'message-full-attachment-only.json',
  'message-metadata.json',
  'message-metadata-auth-results.json',
  'labels-list.json',
] as const

export interface FixtureFile {
  name: string
  fixture: unknown
}

const FORBIDDEN_SUBSTRINGS = ['Bearer ', 'PRIVATE KEY']

/**
 * Throws (listing every offending file name) if any fixture's serialized JSON contains an
 * Authorization: Bearer header anywhere in its structure, or the bare substrings "Bearer " /
 * "PRIVATE KEY" wherever they appear. Serializing first (rather than walking keys) catches both
 * cases with one check: a nested `{ "Authorization": "Bearer x" }` and a leaked string value both
 * become substring-detectable once stringified. Clean fixtures pass through untouched.
 */
export function assertScrubbed(files: FixtureFile[]): void {
  const offenders = files
    .filter(({ fixture }) => {
      const serialized = JSON.stringify(fixture)
      return FORBIDDEN_SUBSTRINGS.some((needle) => serialized.includes(needle))
    })
    .map(({ name }) => name)

  if (offenders.length > 0) {
    throw new Error(`assertScrubbed: fixture(s) contain auth material and must NOT be written: ${offenders.join(', ')}`)
  }
}

/** Mirrors client.test.ts's fixture `query` shape: repeated params become an array, singletons a plain string. */
function buildQuery(searchParams: URLSearchParams): Record<string, string | string[]> | undefined {
  const keys = [...new Set(searchParams.keys())]
  if (keys.length === 0) return undefined
  const query: Record<string, string | string[]> = {}
  for (const key of keys) {
    const values = searchParams.getAll(key)
    query[key] = values.length > 1 ? values : (values[0] as string)
  }
  return query
}

async function captureBody(res: Response): Promise<unknown> {
  // Clone before reading — the original Response body stream still has to reach the real
  // client's own res.text()/JSON.parse() unconsumed.
  const text = await res.clone().text()
  return text.length > 0 ? JSON.parse(text) : null
}

/**
 * Wraps the real global fetch as the client's `fetchFn` seam, capturing each request/response
 * pair keyed by whatever fixture name `target.current` names at call time. `target` is a mutable
 * box the recording sequence below flips between client calls, so unrelated calls never collide
 * and a retried call (e.g. a transient 401) simply overwrites with its own final response.
 */
function createRecordingFetch(target: { current: string | null }, captured: Map<string, CapturedFixture>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const res = await fetch(url, init)
    if (target.current) {
      const u = new URL(String(url))
      captured.set(target.current, {
        request: {
          method: (init?.method ?? 'GET').toUpperCase(),
          path: u.pathname,
          query: buildQuery(u.searchParams),
        },
        response: { status: res.status, body: await captureBody(res) },
      })
    }
    return res
  }) as unknown as typeof fetch
}

interface RequiredEnv {
  saEmail: string
  saKey: string
  impersonate: string
  supportAddress: string
}

function requireEnv(): RequiredEnv {
  const saEmail = process.env.GMAIL_SERVICE_ACCOUNT_EMAIL
  const saKeyRaw = process.env.GMAIL_SERVICE_ACCOUNT_KEY
  const impersonate = process.env.GMAIL_IMPERSONATE
  const supportAddress = process.env.SUPPORT_ADDRESS

  const missing = [
    !saEmail && 'GMAIL_SERVICE_ACCOUNT_EMAIL',
    !saKeyRaw && 'GMAIL_SERVICE_ACCOUNT_KEY',
    !impersonate && 'GMAIL_IMPERSONATE',
    !supportAddress && 'SUPPORT_ADDRESS',
  ].filter((v): v is string => v !== false)

  if (missing.length > 0) {
    throw new Error(`record-fixtures: GMAIL_CONTRACT=1 requires ${missing.join(', ')} to be set.`)
  }

  return {
    saEmail: saEmail as string,
    // Same unescaping apps/ops/src/config.ts applies for the live server — env files carry the
    // PEM's newlines as literal `\n` two-character sequences.
    saKey: (saKeyRaw as string).replace(/\\n/g, '\n'),
    impersonate: impersonate as string,
    supportAddress: supportAddress as string,
  }
}

const FIXTURES_DIR = new URL('../test/fixtures/', import.meta.url)

async function writeFixtures(captured: Map<string, CapturedFixture>): Promise<void> {
  const files: FixtureFile[] = [...captured.entries()].map(([name, fixture]) => ({ name, fixture }))
  // Scratch captures are keyed `candidate:<id>` / `history:<id>` and must all have been consumed
  // by now — a leftover would otherwise resolve as a `candidate:` URL scheme in `new URL()` below.
  const leftovers = files.filter(({ name }) => !/^[\w.-]+\.json$/.test(name)).map(({ name }) => name)
  if (leftovers.length > 0) {
    throw new Error(`record-fixtures: unconsumed scratch capture(s), nothing written: ${leftovers.join(', ')}`)
  }
  assertScrubbed(files)

  for (const { name, fixture } of files) {
    await writeFile(new URL(name, FIXTURES_DIR), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
    console.log(`record-fixtures: wrote ${name}`)
  }
}

/** Runs the live recording sequence. Only ever invoked when GMAIL_CONTRACT === '1'. */
async function recordFixtures(): Promise<void> {
  const { saEmail, saKey, impersonate, supportAddress } = requireEnv()

  const captured = new Map<string, CapturedFixture>()
  const target: { current: string | null } = { current: null }
  const recordingFetch = createRecordingFetch(target, captured)

  // No fetchFn override here on purpose — createGmailAuth's token fetch goes through the plain
  // global fetch, not `recordingFetch`, so the JWT/token-exchange path is structurally excluded
  // from ever being captured.
  const auth = createGmailAuth({ saEmail, saKey, impersonate })
  const client = createGmailClient({ auth, fromAddress: supportAddress, fetchFn: recordingFetch })

  target.current = 'profile.json'
  const profile = await client.getProfile()

  // From the CURRENT historyId there is never anything newer: real Gmail answers with just
  // `{ historyId }` and NO `history` key at all — the shape the client's `raw.history ?? []` exists
  // for, and the one every quiet poll cycle sees.
  target.current = 'history-empty.json'
  await client.listHistory({ startHistoryId: profile.historyId })

  target.current = 'messages-list.json'
  const messages = await client.listMessages({ q: 'in:inbox' })

  const firstMessage = messages.ids[0]
  if (!firstMessage) {
    throw new Error(
      'record-fixtures: listMessages returned no messages — the support inbox needs at least one ' +
        'real received message before recording.',
    )
  }

  // A message whose threadId differs from its own id is a reply inside a thread, so the recorded
  // thread carries more than one message (typically the customer's mail plus our SENT reply).
  const threadSample = messages.ids.find((m) => m.threadId !== m.id) ?? firstMessage
  target.current = 'thread-get.json'
  await client.getThread(threadSample.threadId)

  // Classify messages by real payload shape rather than guessing from listMessages alone, which
  // carries no structural info:
  //   nested      — payload.parts present (multipart/*; every modern client's default)
  //   singlepart  — no parts, a text/* mimeType and inline body.data
  //   attachment-only — no parts and no inline data (e.g. an application/zip DMARC report)
  // The same full-format scan ALSO finds a message that carries an `Authentication-Results` header
  // (FR9) — a real received email naturally has Google's A-R stamp — so its metadata fetch below
  // exercises the money gate's own normalization against real Gmail. Each scanned message's own
  // `historyId` is kept (newest first) as a candidate start point for the history recording.
  let nestedId: string | null = null
  let singlepartId: string | null = null
  let attachmentOnlyId: string | null = null
  let authResultsId: string | null = null
  const historyStarts: string[] = []

  type RawFullBody = {
    historyId?: string
    payload?: {
      mimeType?: string
      body?: { data?: string }
      parts?: unknown[]
      headers?: { name?: string; value?: string }[]
    }
  }
  const classify = (body: RawFullBody): 'nested' | 'singlepart' | 'attachment-only' => {
    const payload = body.payload
    if (Array.isArray(payload?.parts) && payload.parts.length > 0) return 'nested'
    const hasInlineText =
      typeof payload?.mimeType === 'string' &&
      payload.mimeType.toLowerCase().startsWith('text/') &&
      typeof payload.body?.data === 'string' &&
      payload.body.data.length > 0
    return hasInlineText ? 'singlepart' : 'attachment-only'
  }

  for (const { id } of messages.ids) {
    if (nestedId && singlepartId && authResultsId) break

    const scratchKey = `candidate:${id}`
    target.current = scratchKey
    await client.getMessage(id, { format: 'full' })
    const raw = captured.get(scratchKey)
    captured.delete(scratchKey)
    if (!raw) continue

    const body = raw.response.body as RawFullBody
    if (typeof body.historyId === 'string') historyStarts.push(body.historyId)

    const shape = classify(body)
    if (shape === 'nested' && !nestedId) {
      nestedId = id
      captured.set('message-full-nested.json', raw)
    } else if (shape === 'singlepart' && !singlepartId) {
      singlepartId = id
      captured.set('message-full-singlepart.json', raw)
    } else if (shape === 'attachment-only' && !attachmentOnlyId) {
      attachmentOnlyId = id
      captured.set('message-full-attachment-only.json', raw)
    }

    const hasAuthResults = (body.payload?.headers ?? []).some(
      (h) => h.name?.toLowerCase() === 'authentication-results',
    )
    if (hasAuthResults && !authResultsId) authResultsId = id
  }

  if (!singlepartId) {
    // Our own replies are plain single-part text/plain (buildReplyRaw) — the realistic source for
    // this shape, since no mainstream client sends it any more. Still a read: nothing is sent.
    target.current = null // not a fixture — don't capture this listing under the last scan key
    const sent = await client.listMessages({ q: 'in:sent' })
    for (const { id } of sent.ids) {
      const scratchKey = `candidate:${id}`
      target.current = scratchKey
      await client.getMessage(id, { format: 'full' })
      const raw = captured.get(scratchKey)
      captured.delete(scratchKey)
      if (!raw) continue
      if (classify(raw.response.body as RawFullBody) === 'singlepart') {
        singlepartId = id
        captured.set('message-full-singlepart.json', raw)
        console.log(`record-fixtures: no single-part text message in the inbox — using sent copy ${id}`)
        break
      }
    }
  }

  if (!nestedId || !singlepartId) {
    throw new Error(
      `record-fixtures: could not find both a nested-multipart inbox message and a single-part text message ` +
        `(inbox or sent) among ${messages.ids.length} support-inbox message(s) ` +
        `(found nested=${nestedId !== null} singlepart=${singlepartId !== null}). See this script's header comment.`,
    )
  }
  if (!authResultsId) {
    throw new Error(
      'record-fixtures: no inbound message carrying an Authentication-Results header was found — ' +
        'seed a real received email (its Google A-R stamp is the refund money-gate\'s input) so ' +
        'message-metadata-auth-results.json exercises authenticationResults normalization live.',
    )
  }
  if (!attachmentOnlyId) {
    console.log('record-fixtures: no attachment-only inbox message found — message-full-attachment-only.json left as is')
  }

  // history-page1: walk the scanned messages' historyIds newest-first and keep the first page that
  // carries at least one `messagesAdded` record without spilling into a second page — the smallest
  // real page that still exercises the ingest's record mapping. A message's historyId marks its
  // LAST change (our poll's label add), so the newest one usually yields an empty page and the
  // next-older one the arrival record of the newest message. Falls back to the last page tried.
  let historyRecorded = false
  for (const startHistoryId of historyStarts) {
    const scratchKey = `history:${startHistoryId}`
    target.current = scratchKey
    const page = await client.listHistory({ startHistoryId })
    const raw = captured.get(scratchKey)
    captured.delete(scratchKey)
    if (!raw) continue
    const usable = page.records.some((r) => r.messagesAdded.length > 0) && page.nextPageToken === undefined
    if (usable || startHistoryId === historyStarts[historyStarts.length - 1]) {
      captured.set('history-page1.json', raw)
      historyRecorded = true
      console.log(
        `record-fixtures: history-page1 from startHistoryId=${startHistoryId} (${page.records.length} record(s)` +
          `${usable ? '' : ', fallback — no single page with messagesAdded found'})`,
      )
      break
    }
  }
  if (!historyRecorded) {
    console.log('record-fixtures: no scanned message exposed a historyId — history-page1.json left as is')
  }

  // metadata for the single-part message: when it is a sent copy this is also the one recorded
  // message with NO Authentication-Results (Gmail stamps inbound only) and a REAL
  // X-DogeBuddy-Proposal marker on the wire.
  target.current = 'message-metadata.json'
  await client.getMessage(singlepartId, { format: 'metadata' })

  // FR9: metadata for a message that carries Authentication-Results — the topmost A-R header is the
  // refund sender-auth gate's input, and `getMessage(format:'metadata')` requests it (it is in
  // METADATA_HEADERS), so this fixture validates that normalization against real Gmail.
  target.current = 'message-metadata-auth-results.json'
  await client.getMessage(authResultsId, { format: 'metadata' })

  target.current = 'labels-list.json'
  await client.listLabels()

  target.current = null

  await writeFixtures(captured)
  console.log(`record-fixtures: wrote ${captured.size} fixture file(s) to ${fileURLToPath(FIXTURES_DIR)}`)
}

function printUsage(): void {
  console.log(
    [
      'record-fixtures: GMAIL_CONTRACT is unset (or not "1") — nothing was recorded.',
      '',
      'Usage (from repo root):',
      '  set -a && . apps/ops/.env && set +a && GMAIL_CONTRACT=1 \\',
      '    pnpm --filter @doge-buddy/gmail exec tsx scripts/record-fixtures.ts',
      '',
      'Requires GMAIL_SERVICE_ACCOUNT_EMAIL, GMAIL_SERVICE_ACCOUNT_KEY, GMAIL_IMPERSONATE, SUPPORT_ADDRESS',
      'in the environment, and at least one real received message in the support inbox (the',
      'single-part text case falls back to a sent copy of our own reply).',
    ].join('\n'),
  )
}

// Only runs the network/filesystem-touching sequence when this file is the actual process entry
// point (`tsx scripts/record-fixtures.ts`) — never on import, so the test file above can import
// assertScrubbed without triggering a live run or an unwanted process.exit().
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMainModule) {
  if (process.env.GMAIL_CONTRACT !== '1') {
    printUsage()
    process.exit(0)
  }

  try {
    await recordFixtures()
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
